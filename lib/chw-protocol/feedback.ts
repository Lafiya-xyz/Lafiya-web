/**
 * Issue #915: patient feedback on CHW visits via SMS/USSD.
 *
 * Pure, side-effect-free core of the feedback survey:
 *   • multilingual survey templates (en, ha, ig, yo) — no PHI variables,
 *   • inbound reply parsing that tolerates typos, casing, punctuation and
 *     common SMS/USSD variants,
 *   • dispute / payout-hold decision on negative confirmations,
 *   • k-anonymized per-CHW aggregation (suppress small cohorts).
 *
 * Privacy: replies are keyed by an opaque survey token, never by patient
 * identity. Aggregates are only emitted for cohorts of at least
 * `K_ANONYMITY_THRESHOLD` responses; smaller cohorts are suppressed entirely.
 */

import type { SupportedLocale } from "@/lib/notifications/types";

export const FEEDBACK_LOCALES: readonly SupportedLocale[] = ["en", "ha", "ig", "yo"];

/** Minimum responses per CHW before any aggregate is published. */
export const K_ANONYMITY_THRESHOLD = 5;

export type FeedbackAnswer = "yes" | "no" | "unsure";

export type FeedbackParseResult =
  | { kind: "answer"; answer: FeedbackAnswer }
  | { kind: "opt_out" }
  | { kind: "unrecognized" };

/** Survey prompt per locale. Variables: {chw_ref} (opaque, non-PHI). */
export const FEEDBACK_SURVEY_TEMPLATES: Record<SupportedLocale, string> = {
  en: "Lafiya: did a community health worker visit you today? Reply YES or NO. Reply STOP to opt out.",
  ha: "Lafiya: ma'aikacin lafiya na al'umma ya ziyarce ka yau? Amsa EH ko A'A. Amsa STOP don fita.",
  ig: "Lafiya: onye ọrụ ahụike obodo bịara gị taa? Zaa EE ma ọ bụ MBÀ. Zaa STOP iji pụọ.",
  yo: "Lafiya: oṣiṣẹ ìlera àdúgbò ṣèbẹ̀wò sí ọ lónìí? Dáhùn BẸ́Ẹ̀NI tàbí RÁRÁ. Dáhùn STOP láti jáde.",
};

/** Opt-out keywords (case/space-insensitive). */
const OPT_OUT_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "fita", "pụọ", "pụo", "jade"]);

const YES_WORDS = new Set([
  "yes", "y", "yeah", "yep", "yup", "ya", "1", "true", "eh", "ehe", "ee", "ehee",
  "bẹẹni", "beeni", "bẹni", "beni", "bẹ́ẹ̀ni", "correct", "confirm", "confirmed",
]);
const NO_WORDS = new Set([
  "no", "n", "nope", "nah", "0", "false", "a'a", "aa", "awo", "mba", "mbaa",
  "rara", "rára", "never", "deny", "denied",
]);
const UNSURE_WORDS = new Set(["unsure", "maybe", "idk", "dunno", "?", "amaghị", "amaghi", "ko", "kò"]);

/** Normalizes a raw reply: lowercase, strip punctuation/emoji, collapse spaces. */
export function normalizeReply(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bounded Levenshtein distance (early-exit above `max`). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function matchWord(word: string, words: Set<string>): boolean {
  if (words.has(word)) return true;
  // Typos: allow one edit for words of 3+ chars, two for 5+ chars.
  const max = word.length >= 5 ? 2 : word.length >= 3 ? 1 : 0;
  if (max === 0) return false;
  for (const candidate of words) {
    if (editDistance(word, candidate, max) <= max) return true;
  }
  return false;
}

/**
 * Parses an inbound SMS/USSD reply into a survey answer.
 * Opt-out wins over any answer so a "no stop" reply still unsubscribes.
 */
export function parseFeedbackReply(raw: string): FeedbackParseResult {
  const normalized = normalizeReply(raw);
  if (!normalized) return { kind: "unrecognized" };
  const tokens = normalized.split(" ");

  if (tokens.some((t) => OPT_OUT_KEYWORDS.has(t))) return { kind: "opt_out" };

  // USSD menus answer with a bare digit.
  if (tokens.length === 1 && tokens[0] === "1") return { kind: "answer", answer: "yes" };
  if (tokens.length === 1 && tokens[0] === "2") return { kind: "answer", answer: "no" };
  if (tokens.length === 1 && tokens[0] === "3") return { kind: "answer", answer: "unsure" };

  for (const token of tokens) {
    if (matchWord(token, YES_WORDS)) return { kind: "answer", answer: "yes" };
    if (matchWord(token, NO_WORDS)) return { kind: "answer", answer: "no" };
    if (matchWord(token, UNSURE_WORDS)) return { kind: "answer", answer: "unsure" };
  }
  return { kind: "unrecognized" };
}

export type DisputeDecision =
  | { action: "none" }
  | { action: "open_dispute"; holdPayout: true; reasonCode: "patient_denied_visit" };

/**
 * A negative confirmation opens a dispute and holds the CHW's payout for the
 * visit. "unsure" never holds funds; it is routed to manual review elsewhere.
 */
export function decideDispute(answer: FeedbackAnswer): DisputeDecision {
  if (answer === "no") {
    return { action: "open_dispute", holdPayout: true, reasonCode: "patient_denied_visit" };
  }
  return { action: "none" };
}

export type FeedbackResponse = {
  chwId: string;
  answer: FeedbackAnswer;
};

export type ChwFeedbackAggregate = {
  chwId: string;
  responses: number;
  yes: number;
  no: number;
  unsure: number;
  /** Share of negative confirmations, rounded to 3 decimals. */
  negativeRate: number;
};

/**
 * k-anonymized per-CHW aggregation. CHWs with fewer than `threshold`
 * responses are omitted entirely (no counts, no rates).
 */
export function aggregateFeedback(
  responses: readonly FeedbackResponse[],
  threshold: number = K_ANONYMITY_THRESHOLD,
): ChwFeedbackAggregate[] {
  const buckets = new Map<string, { yes: number; no: number; unsure: number }>();
  for (const r of responses) {
    const b = buckets.get(r.chwId) ?? { yes: 0, no: 0, unsure: 0 };
    b[r.answer] += 1;
    buckets.set(r.chwId, b);
  }

  const out: ChwFeedbackAggregate[] = [];
  for (const [chwId, b] of buckets) {
    const total = b.yes + b.no + b.unsure;
    if (total < threshold) continue;
    out.push({
      chwId,
      responses: total,
      yes: b.yes,
      no: b.no,
      unsure: b.unsure,
      negativeRate: Math.round((b.no / total) * 1000) / 1000,
    });
  }
  return out.sort((a, b) => a.chwId.localeCompare(b.chwId));
}
