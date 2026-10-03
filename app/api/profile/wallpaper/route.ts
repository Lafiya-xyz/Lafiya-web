import { NextResponse } from "next/server";

import { checkAndIncrementFrequency } from "@/lib/frequency-limit";
import { logError } from "@/lib/logging/logger";
import { QrCapacityError } from "@/lib/qr/generateQrDataUrl";
import { createClient } from "@/lib/supabase/server";
import { getBaseUrl } from "@/lib/url/getBaseUrl";
import {
  generateWallpaper,
  WALLPAPER_FIELDS,
  WALLPAPER_RESOLUTIONS,
  type WallpaperField,
  type WallpaperFieldValues,
  type WallpaperResolution,
} from "@/lib/wallpaper/generateWallpaper";

// Caps how many wallpapers a single authenticated user can generate in a
// rolling window. Each generation is a real (if small) render — QR encode
// plus an SVG rasterize/composite — so this bounds burst load the same way
// UPLOAD_FREQUENCY_MAX does for photo uploads in ../photo/route.ts.
const WALLPAPER_FREQUENCY_MAX = 10;
const WALLPAPER_FREQUENCY_WINDOW_SECONDS = 60;

function isWallpaperResolution(value: unknown): value is WallpaperResolution {
  return typeof value === "string" && value in WALLPAPER_RESOLUTIONS;
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
      `wallpaper-generate:${user.id}`,
      WALLPAPER_FREQUENCY_MAX,
      WALLPAPER_FREQUENCY_WINDOW_SECONDS,
    );

    if (!frequency.allowed) {
      return NextResponse.json(
        { error: "Too many wallpaper generations. Please try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(frequency.retryAfterSeconds) },
        },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { resolution, fields } = (body ?? {}) as {
      resolution?: unknown;
      fields?: unknown;
    };

    if (!isWallpaperResolution(resolution)) {
      return NextResponse.json(
        { error: "Unsupported resolution" },
        { status: 400 },
      );
    }

    // Only fields the caller explicitly opted in to for this generation,
    // and only ones on the allow-list, are ever rendered onto the image —
    // this is the "privacy-configurable" contract: nothing is shown by
    // default beyond the QR code itself.
    const requestedFields = Array.isArray(fields) ? fields : [];
    const selectedFields = WALLPAPER_FIELDS.filter((field) =>
      requestedFields.includes(field),
    );

    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "card_public_id, blood_group, genotype, allergies, medications, chronic_conditions",
      )
      .eq("user_id", user.id)
      .maybeSingle();

    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }

    const fieldValues: WallpaperFieldValues = {
      blood_group:
        profile.blood_group && profile.blood_group !== "unknown"
          ? profile.blood_group
          : undefined,
      genotype:
        profile.genotype && profile.genotype !== "unknown"
          ? profile.genotype
          : undefined,
      allergies: profile.allergies?.length ? profile.allergies.join(", ") : undefined,
      medications: profile.medications?.length
        ? profile.medications.join(", ")
        : undefined,
      chronic_conditions: profile.chronic_conditions?.length
        ? profile.chronic_conditions.join(", ")
        : undefined,
    };

    const cardUrl = `${await getBaseUrl()}/card/${profile.card_public_id}`;

    let png: Buffer;
    try {
      png = await generateWallpaper({
        cardUrl,
        resolution,
        selectedFields: selectedFields as WallpaperField[],
        fieldValues,
      });
    } catch (error) {
      if (error instanceof QrCapacityError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    return new NextResponse(png, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="lafiya-medical-id-wallpaper-${resolution}.png"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    logError("Error generating wallpaper", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
