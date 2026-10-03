"use client";

import { useState } from "react";

const RESOLUTIONS = [
  { value: "1080x2400", label: "1080 × 2400 (most phones)" },
  { value: "720x1600", label: "720 × 1600 (lower-end devices)" },
] as const;

const FIELDS = [
  { value: "blood_group", label: "Blood group" },
  { value: "genotype", label: "Genotype" },
  { value: "allergies", label: "Allergies" },
  { value: "medications", label: "Medications" },
  { value: "chronic_conditions", label: "Chronic conditions" },
] as const;

/**
 * Generates a lock-screen wallpaper containing the emergency QR code.
 *
 * Privacy note: every checkbox here starts unchecked. The wallpaper is
 * visible to anyone holding the phone without unlocking it, so — unlike
 * the public card's disclosure settings above — nothing beyond the QR code
 * is shown unless explicitly opted in to for this specific image.
 */
export function WallpaperGenerator() {
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]["value"]>(
    RESOLUTIONS[0].value,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"idle" | "generating" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function toggleField(field: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  }

  async function handleGenerate() {
    setStatus("generating");
    setErrorMessage(null);
    try {
      const response = await fetch("/api/profile/wallpaper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolution,
          fields: Array.from(selected),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setErrorMessage(
          data?.error ?? "Could not generate wallpaper. Please try again.",
        );
        setStatus("error");
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `lafiya-medical-id-wallpaper-${resolution}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus("idle");
    } catch {
      setErrorMessage("Could not generate wallpaper. Please try again.");
      setStatus("error");
    }
  }

  return (
    <section
      aria-labelledby="wallpaper-generator-heading"
      className="flex flex-col gap-4 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"
    >
      <div>
        <h2 id="wallpaper-generator-heading" className="font-semibold">
          Lock-screen wallpaper
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Generate a wallpaper with your emergency QR code so responders can
          scan it straight from your lock screen, without unlocking your
          phone. Anyone who picks up your phone can see whatever you choose
          below, so it defaults to the QR code only.
        </p>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Screen size</legend>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4">
          {RESOLUTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2">
              <input
                type="radio"
                name="wallpaper-resolution"
                value={option.value}
                checked={resolution === option.value}
                onChange={() => setResolution(option.value)}
                className="focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 dark:focus:ring-zinc-600"
              />
              <span className="text-sm">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">
          Facts to show on the wallpaper itself (optional)
        </legend>
        <p className="mt-1 text-xs text-zinc-500">
          Unselected fields are only visible after scanning the QR code, on
          your existing public card privacy settings.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <label key={field.value} className="flex gap-2">
              <input
                type="checkbox"
                checked={selected.has(field.value)}
                onChange={() => toggleField(field.value)}
                className="focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 dark:focus:ring-zinc-600"
              />
              <span className="text-sm">{field.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={status === "generating"}
        className="min-h-11 self-start rounded-full bg-zinc-950 px-5 py-2 text-white focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:focus:ring-zinc-600"
      >
        {status === "generating" ? "Generating…" : "Download wallpaper"}
      </button>

      <div aria-live="polite" className="text-sm text-red-600 dark:text-red-400">
        {status === "error" ? errorMessage : null}
      </div>
    </section>
  );
}
