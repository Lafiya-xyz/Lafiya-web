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

// Responsive avatar variants generated at upload time so cards can serve a
// few-KB image over slow connections instead of paying on-the-fly
// optimization latency/cost on every cache miss. The largest variant stays
// within the existing 800x800 pixel budget.
const VARIANT_WIDTHS = [96, 192, 400] as const;
const VARIANT_FORMATS = ["avif", "webp", "jpeg"] as const;
type VariantFormat = (typeof VARIANT_FORMATS)[number];

const FORMAT_EXTENSION: Record<VariantFormat, string> = {
  avif: "avif",
  webp: "webp",
  jpeg: "jpg",
};

const FORMAT_CONTENT_TYPE: Record<VariantFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
};

// Deterministic storage key for a given user/width/format. Deriving the key
// from the identity (rather than a random name) means a replacement always
// overwrites the same objects, so no orphaned variants can accumulate.
function variantPath(userId: string, width: number, format: VariantFormat) {
  return `${userId}/photo-${width}.${FORMAT_EXTENSION[format]}`;
}

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

    // Resize: max 800px on any side, keep aspect ratio. This is the shared
    // base the per-variant resizes below derive from, so the pixel budget
    // (and the decode cost) is unchanged from the single-output pipeline.
    sharpInstance = sharpInstance.resize({
      width: 800,
      height: 800,
      fit: "inside",
      withoutEnlargement: true,
    });

    // Encode the base once, then derive every variant from it. A file whose
    // container header declares dimensions within budget but whose actual
    // compressed payload doesn't match (a malformed/adversarial file, not a
    // resource-exhaustion vector -- decoders are bounded by the *declared*
    // header size and error out quickly rather than processing the
    // mismatched real payload) fails here, not at metadata() above.
    let baseBuffer: Buffer;
    try {
      baseBuffer = await sharpInstance.png().toBuffer();
    } catch {
      return NextResponse.json(
        { error: "Invalid or corrupted image data" },
        { status: 400 },
      );
    }

    // Emit all width x format variants in parallel, each within the existing
    // pixel budget (the largest is 400px, well under the 800px base).
    let variants: { path: string; buffer: Buffer; contentType: string }[];
    try {
      const encoded = await Promise.all(
        VARIANT_WIDTHS.flatMap((variantWidth) =>
          VARIANT_FORMATS.map(async (format) => {
            const pipeline = sharp(baseBuffer).resize({
              width: variantWidth,
              height: variantWidth,
              fit: "inside",
              withoutEnlargement: true,
            });

            const variantBuffer =
              format === "avif"
                ? await pipeline.avif({ quality: 50 }).toBuffer()
                : format === "webp"
                  ? await pipeline.webp({ quality: 70 }).toBuffer()
                  : await pipeline.jpeg({ quality: 75 }).toBuffer();

            return {
              path: variantPath(user.id, variantWidth, format),
              buffer: variantBuffer,
              contentType: FORMAT_CONTENT_TYPE[format],
            };
          }),
        ),
      );
      variants = encoded;
    } catch {
      return NextResponse.json(
        { error: "Invalid or corrupted image data" },
        { status: 400 },
      );
    }

    // Uploads are atomic: write every variant first, then only report success
    // once all writes land. On any partial failure, remove the objects we did
    // write so a replacement never leaves orphaned variants behind.
    const written: string[] = [];
    for (const variant of variants) {
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(variant.path, variant.buffer, {
          upsert: true,
          contentType: variant.contentType,
        });

      if (uploadError) {
        if (written.length > 0) {
          await supabase.storage.from("avatars").remove(written);
        }
        return NextResponse.json(
          { error: uploadError.message },
          { status: 500 },
        );
      }

      written.push(variant.path);
    }

    const { data } = supabase.storage
      .from("avatars")
      .getPublicUrl(variantPath(user.id, 400, "jpeg"));

    return NextResponse.json({
      publicUrl: data.publicUrl,
      variants: VARIANT_WIDTHS.map((variantWidth) => ({
        width: variantWidth,
        avif: supabase.storage
          .from("avatars")
          .getPublicUrl(variantPath(user.id, variantWidth, "avif")).data.publicUrl,
        webp: supabase.storage
          .from("avatars")
          .getPublicUrl(variantPath(user.id, variantWidth, "webp")).data.publicUrl,
        jpeg: supabase.storage
          .from("avatars")
          .getPublicUrl(variantPath(user.id, variantWidth, "jpeg")).data.publicUrl,
      })),
    });
  } catch (error: unknown) {
    logError("Error handling avatar upload", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
