import { NextResponse } from "next/server";
import sharp from "sharp";

import { checkAndIncrementFrequency } from "@/lib/frequency-limit";
import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

// The final output is capped at 800x800 (640,000px) by the resize() call
// below. This ceiling is a deliberately generous ~100x that -- comfortably
// above real-world high-resolution photos (including 48-60MP phone/DSLR
// sensors, e.g. a 9504x6336 shot is ~60M px) -- while sitting far below
// decompression-bomb-style inputs, which rely on hundreds of millions of
// pixels compressing into a tiny file to blow past a request's memory
// budget (a 15000x15000 solid-color PNG, for example, is ~225M px). At this
// ceiling, worst-case raw RGBA decode is ~256MB: bounded and predictable
// rather than the 900MB+ a bomb image would otherwise force. Passed to the
// sharp() constructor (not just checked manually) so it's also enforced as
// an authoritative backstop by libvips itself at actual decode time,
// independent of anything our own metadata check inspects.
const MAX_INPUT_PIXELS = 64_000_000;
// Secondary guard against degenerate aspect ratios (e.g. 1 x 60,000,000)
// that could satisfy the pixel budget above without being a real photo;
// comfortably above the widest single dimension any consumer camera
// produces (~9504px).
const MAX_INPUT_DIMENSION = 10_000;

// Caps how many photo uploads a single authenticated user can push through
// this route in a rolling window, independent of the dimension check above
// -- a burst of concurrently-submitted, individually-within-budget uploads
// from one account could otherwise still exhaust shared CPU/memory by sheer
// parallelism (each decode+resize is real, bounded-but-nonzero work).
const UPLOAD_FREQUENCY_MAX = 5;
const UPLOAD_FREQUENCY_WINDOW_SECONDS = 60;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const frequency = await checkAndIncrementFrequency(
      `photo-upload:${user.id}`,
      UPLOAD_FREQUENCY_MAX,
      UPLOAD_FREQUENCY_WINDOW_SECONDS,
    );

    if (!frequency.allowed) {
      return NextResponse.json(
        { error: "Too many photo uploads. Please try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(frequency.retryAfterSeconds) },
        },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "Invalid file type" }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Photo must be under 5 MB." },
        { status: 400 },
      );
    }

    // Read the file into a Node Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Process the image: resize and strip EXIF (sharp strips EXIF by default)
    // limitInputPixels makes libvips itself refuse to decode past our
    // ceiling -- an authoritative backstop enforced at actual decode time,
    // not just against whatever our own metadata check below inspects.
    let sharpInstance = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS });

    // Get metadata to confirm format and dimensions. metadata() only reads
    // the image's header/container information -- it does not decode pixel
    // data -- so this dimension check runs before any of the expensive work
    // (full decompression + resize) the route would otherwise do
    // unconditionally on every request.
    let metadata: Awaited<ReturnType<typeof sharpInstance.metadata>>;
    try {
      metadata = await sharpInstance.metadata();
    } catch {
      return NextResponse.json(
        { error: "Photo dimensions are too large to process." },
        { status: 400 },
      );
    }

    if (!metadata.format) {
      return NextResponse.json(
        { error: "Invalid image data" },
        { status: 400 },
      );
    }

    const FORMAT_TO_MIME: Record<string, string> = {
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    };
    const actualMime = FORMAT_TO_MIME[metadata.format];
    if (!actualMime || actualMime !== file.type) {
      return NextResponse.json(
        { error: "File content does not match declared type" },
        { status: 400 },
      );
    }

    const { width, height } = metadata;
    if (
      !width ||
      !height ||
      width > MAX_INPUT_DIMENSION ||
      height > MAX_INPUT_DIMENSION ||
      width * height > MAX_INPUT_PIXELS
    ) {
      return NextResponse.json(
        { error: "Photo dimensions are too large to process." },
        { status: 400 },
      );
    }

    // Resize: max 800px on any side, keep aspect ratio
    sharpInstance = sharpInstance.resize({
      width: 800,
      height: 800,
      fit: "inside",
      withoutEnlargement: true,
    });

    let outputBuffer: Buffer;
    const mimeType = file.type;
    let extension = "jpg";

    // A file whose container header declares dimensions within budget but
    // whose actual compressed payload doesn't match (a malformed/adversarial
    // file, not a resource-exhaustion vector -- decoders are bounded by the
    // *declared* header size and error out quickly rather than processing
    // the mismatched real payload) fails here, not at metadata() above.
    try {
      if (file.type === "image/png") {
        outputBuffer = await sharpInstance.png().toBuffer();
        extension = "png";
      } else if (file.type === "image/webp") {
        outputBuffer = await sharpInstance.webp().toBuffer();
        extension = "webp";
      } else {
        outputBuffer = await sharpInstance.jpeg().toBuffer();
        extension = "jpg";
      }
    } catch {
      return NextResponse.json(
        { error: "Invalid or corrupted image data" },
        { status: 400 },
      );
    }

    const path = `${user.id}/photo.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, outputBuffer, {
        upsert: true,
        contentType: mimeType,
      });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = supabase.storage.from("avatars").getPublicUrl(path);

    return NextResponse.json({ publicUrl: data.publicUrl });
  } catch (error: unknown) {
    logError("Error handling avatar upload", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
