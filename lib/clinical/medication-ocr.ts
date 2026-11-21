/**
 * Issue #922: on-device OCR assistance for medication entry.
 *
 * This module is pure and dependency-free so it can run entirely in the
 * browser (or a worker) with no network access: it takes the raw text an
 * on-device OCR engine (e.g. Tesseract.js WASM) produced from a photo of
 * medication packaging or a prescription, and turns it into normalized
 * suggestions drawn from the curated Nigerian EML list in
 * lib/validation/profile.ts.
 *
 * Nothing here saves anything. Callers must present the suggestions for
 * patient confirmation and only then write the confirmed value into the
 * form. Images never leave the device: this module only ever sees text.
 */

import { COMMON_MEDICATIONS } from "@/lib/validation/profile";

/** Minimum similarity (0..1) for a token to be offered as a suggestion. */
export const MIN_MATCH_SCORE = 0.72;

/** Maximum number of suggestions returned per OCR pass. */
export const MAX_SUGGESTIONS = 5;

/**
 * Shown next to every suggestion list. OCR misreads are common, so the
 * patient must confirm each entry before it is saved.
 */
export const MEDICATION_OCR_DISCLAIMER =
  "Check each suggestion against the package before saving. OCR can misread drug names.";

export type MedicationSuggestion = {
  /** Normalized generic name from COMMON_MEDICATIONS. */
  name: string;
  /** Similarity of the best matching OCR token, 0..1. */
  score: number;
  /** The OCR token that produced the match, for patient verification. */
  matchedText: string;
};

/**
 * Lowercases, strips diacritics and collapses everything that is not a
 * letter or digit into single spaces. OCR output is noisy: line breaks,
 * stray punctuation, "500mg" glued to the name, etc.
 */
export function normalizeOcrText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Levenshtein distance with an early exit once the distance exceeds
 * `maxDistance`, so long OCR lines don't cost O(n*m) per candidate.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length];
}

/** Similarity in 0..1 derived from the Levenshtein distance. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  const distance = levenshtein(a, b, longest);
  return distance > longest ? 0 : 1 - distance / longest;
}

/**
 * Splits normalized OCR text into candidate tokens. Multi-word generic names
 * ("Sodium Valproate", "Folic Acid") are matched against sliding windows of
 * up to three tokens, so both single words and short phrases are considered.
 */
function candidateWindows(normalized: string): string[] {
  const tokens = normalized.split(" ").filter((token) => token.length >= 3);
  const windows: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (let size = 1; size <= 3 && i + size <= tokens.length; size += 1) {
      windows.push(tokens.slice(i, i + size).join(" "));
    }
  }
  return windows;
}

/**
 * Fuzzy-matches OCR text against the curated medication list and returns
 * normalized suggestions, best first. Never mutates or persists anything.
 */
export function suggestMedications(
  ocrText: string,
  options: { minScore?: number; limit?: number } = {},
): MedicationSuggestion[] {
  const minScore = options.minScore ?? MIN_MATCH_SCORE;
  const limit = options.limit ?? MAX_SUGGESTIONS;

  const windows = candidateWindows(normalizeOcrText(ocrText));
  if (windows.length === 0) return [];

  const best = new Map<string, MedicationSuggestion>();
  for (const name of COMMON_MEDICATIONS) {
    const target = normalizeOcrText(name);
    let bestScore = 0;
    let bestText = "";
    for (const window of windows) {
      const score = similarity(window, target);
      if (score > bestScore) {
        bestScore = score;
        bestText = window;
      }
    }
    if (bestScore >= minScore) {
      best.set(name, { name, score: bestScore, matchedText: bestText });
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "en"))
    .slice(0, limit);
}

/**
 * Formats a confirmed suggestion for the medications tag list, e.g.
 * "Metformin 500mg" when a strength was read from the packaging.
 */
export function formatMedicationEntry(
  name: string,
  strength?: string | null,
): string {
  const trimmedStrength = strength?.trim();
  return trimmedStrength ? `${name} ${trimmedStrength}` : name;
}
