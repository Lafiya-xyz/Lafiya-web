/**
 * Issue #872: captive-portal and zero-rated network detection.
 *
 * `navigator.onLine` is true behind captive portals and walled gardens, so
 * we probe `/api/connectivity` with a random nonce and verify the HMAC it
 * returns. A portal answering every request with HTTP 200 HTML cannot
 * produce a matching MAC for a fresh nonce.
 *
 * The key is a public, build-time constant: this is an integrity check
 * against generic interception, not authentication. `public/sw.js` mirrors
 * these constants (it cannot import TypeScript).
 */

export type ConnectivityState = "online" | "captive" | "degraded" | "offline";

export const CONNECTIVITY_PATH = "/api/connectivity";
export const CONNECTIVITY_PROBE_KEY = "lafiya-connectivity-probe-v1";
/** Header set by proxy.ts on first-party card responses. */
export const ORIGIN_MARKER_HEADER = "x-lafiya-origin";
/** Network budget before card navigations fall back to the offline envelope. */
export const CARD_NAVIGATION_BUDGET_MS = 2500;
/** postMessage type the service worker uses to broadcast the classification. */
export const CONNECTIVITY_MESSAGE = "LAFIYA_CONNECTIVITY";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function signConnectivityNonce(nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CONNECTIVITY_PROBE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(nonce)));
}

export type ProbeOutcome =
  | { kind: "error" }
  | { kind: "timeout" }
  | { kind: "response"; verified: boolean; elapsedMs: number };

export function classifyProbe(
  outcome: ProbeOutcome,
  budgetMs: number = CARD_NAVIGATION_BUDGET_MS,
): ConnectivityState {
  if (outcome.kind === "error") return "offline";
  if (outcome.kind === "timeout") return "degraded";
  if (!outcome.verified) return "captive";
  return outcome.elapsedMs > budgetMs ? "degraded" : "online";
}
