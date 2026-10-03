import { createHash } from "node:crypto";

/**
 * Breached-password check using the Have I Been Pwned range API.
 *
 * Privacy properties (k-anonymity):
 * - Only the first five hex characters of the SHA-1 hash of the password are
 *   sent to the third party. The full hash and the plaintext password never
 *   leave the server.
 * - The API response is padded, so the number of suffixes returned does not
 *   reveal whether the queried prefix exists in the corpus.
 * - No PHI, capability tokens, or user identifiers are sent.
 *
 * Availability: the check fails open. If the API is unreachable or times out
 * (1s), the password is treated as not breached and a warning is logged so a
 * third-party outage does not break sign-up.
 */

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const REQUEST_TIMEOUT_MS = 1000;
const CACHE_MAX_ENTRIES = 64;

/** Small in-memory LRU cache keyed by the five-character hash prefix. */
const prefixCache = new Map<string, Map<string, number>>();

function readCache(prefix: string): Map<string, number> | undefined {
  const cached = prefixCache.get(prefix);
  if (cached) {
    // Refresh recency.
    prefixCache.delete(prefix);
    prefixCache.set(prefix, cached);
  }
  return cached;
}

function writeCache(prefix: string, suffixes: Map<string, number>): void {
  prefixCache.set(prefix, suffixes);
  if (prefixCache.size > CACHE_MAX_ENTRIES) {
    const oldest = prefixCache.keys().next().value;
    if (oldest !== undefined) {
      prefixCache.delete(oldest);
    }
  }
}

function parseRangeResponse(body: string): Map<string, number> {
  const suffixes = new Map<string, number>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [suffix, count] = trimmed.split(":");
    if (!suffix) continue;
    suffixes.set(suffix.toUpperCase(), Number.parseInt(count ?? "0", 10) || 0);
  }
  return suffixes;
}

async function fetchRange(prefix: string): Promise<Map<string, number> | null> {
  const cached = readCache(prefix);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
      signal: controller.signal,
      headers: {
        // Request padded responses so the payload size does not leak whether
        // the prefix exists in the corpus.
        "Add-Padding": "true",
        "User-Agent": "lafiya-breached-password-check",
      },
    });
    if (!response.ok) {
      console.warn(
        `[breached-password] HIBP range API returned ${response.status}; failing open.`,
      );
      return null;
    }
    const suffixes = parseRangeResponse(await response.text());
    writeCache(prefix, suffixes);
    return suffixes;
  } catch (error) {
    console.warn(
      "[breached-password] HIBP range API unavailable; failing open.",
      error,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns true when the password appears in a known breach corpus.
 * Fails open (returns false) when the range API is unavailable.
 */
export async function isBreachedPassword(password: string): Promise<boolean> {
  if (!password) return false;

  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const suffixes = await fetchRange(prefix);
  if (!suffixes) return false;

  return (suffixes.get(suffix) ?? 0) > 0;
}

/** Clears the in-memory prefix cache. Exposed for tests. */
export function clearBreachedPasswordCache(): void {
  prefixCache.clear();
}
