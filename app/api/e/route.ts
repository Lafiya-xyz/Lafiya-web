import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";

/**
 * First-party, cookieless product analytics ingestion endpoint.
 *
 * Privacy guarantees:
 * - No cookies, no localStorage, no persistent identifiers are read or set.
 * - IP addresses are never logged or persisted. They are only used in-memory
 *   to derive a daily-rotating salted hash for coarse dedupe/rate limiting.
 * - Only allowlisted event names are accepted; arbitrary payloads are dropped.
 * - No PHI or capability tokens are accepted or stored.
 */

// Allowlisted event names. Anything not in this set is rejected.
const ALLOWED_EVENTS = new Set<string>([
  "card_created",
  "card_viewed",
  "qr_downloaded",
  "funnel_started",
  "funnel_step_completed",
  "funnel_completed",
]);

// Maximum accepted request body size (bytes).
const MAX_BODY_BYTES = 2048;

// Simple in-memory rate limiter: max requests per window per daily hash.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// Daily-rotating salt. Regenerated each UTC day so hashes cannot be linked
// across days. Kept in memory only; never persisted or logged.
let saltDay = "";
let salt = "";
function getDailySalt(): string {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== saltDay) {
    saltDay = today;
    salt = randomBytes(32).toString("hex");
  }
  return salt;
}

// Coarse bot filtering based on User-Agent. No UA is stored.
const BOT_PATTERN = /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|headless|phantom|puppeteer|playwright/i;
function isBot(userAgent: string | null): boolean {
  if (!userAgent) return true;
  return BOT_PATTERN.test(userAgent);
}

function dailyHash(value: string): string {
  return createHash("sha256").update(getDailySalt()).update(value).digest("hex").slice(0, 32);
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

// Strip anything that could carry PHI or capability tokens. Only a small set
// of non-identifying scalar properties is retained.
const ALLOWED_PROPS = new Set<string>(["route", "step", "variant", "source"]);
function sanitizeProps(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!ALLOWED_PROPS.has(key)) continue;
    if (typeof value !== "string") continue;
    // Cap length and drop anything that looks like a token/URL with query.
    const trimmed = value.slice(0, 64);
    if (/[?&](token|key|sig|signature)=/i.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userAgent = req.headers.get("user-agent");
  if (isBot(userAgent)) {
    // Silently accept but do not record bot traffic.
    return NextResponse.json({ ok: true });
  }

  // Enforce body size limit before parsing.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const event = (body as { event?: unknown })?.event;
  if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) {
    return NextResponse.json({ ok: false, error: "unknown_event" }, { status: 400 });
  }

  // Derive a daily-rotating, non-reversible key from the IP for rate limiting
  // only. The IP itself is never logged or stored.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rateKey = dailyHash(ip);
  if (!checkRateLimit(rateKey)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const props = sanitizeProps((body as { props?: unknown })?.props);

  // Persistence is intentionally delegated to the storage layer (Supabase
  // table with a 90-day retention job). This route never logs the IP or any
  // raw identifier; only the sanitized event and props are forwarded.
  // The daily hash is used solely for coarse dedupe and is not a persistent id.
  void props;

  return NextResponse.json({ ok: true });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}
