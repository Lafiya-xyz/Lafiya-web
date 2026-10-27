/**
 * Partner sandbox mode (issue #786).
 *
 * Requests that present a sandbox API key (`Authorization: Bearer lfy_sbx_…`
 * listed in LAFIYA_SANDBOX_API_KEYS) are served entirely from the in-code
 * synthetic fixtures below. The sandbox path never calls Soroban, Supabase or
 * the production rate-limit table, so a sandbox key cannot read production
 * data. Conversely, fixture hashes are only resolved for sandbox keys, so
 * production callers never see synthetic records.
 *
 * Every sandbox response is marked with `sandbox: true` and the
 * `X-Lafiya-Sandbox: true` header. See docs/partner-sandbox.md.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const SANDBOX_KEY_PREFIX = "lfy_sbx_";
export const SANDBOX_HEADER = "X-Lafiya-Sandbox";
export const SANDBOX_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export type SandboxLifecycleState =
  "verified" | "revoked" | "archived" | "pending";

export interface SandboxFixture {
  state: SandboxLifecycleState;
  verified: boolean;
  attestation: {
    recordHash: string;
    attester: string;
    timestamp: number;
    state: SandboxLifecycleState;
  } | null;
}

const ATTESTOR = "GSANDBOXATTESTOR000000000000000000000000000000000000000";

function fixture(
  state: SandboxLifecycleState,
  digit: string,
  timestamp: number,
): [string, SandboxFixture] {
  const recordHash = digit.repeat(64);
  return [
    recordHash,
    {
      state,
      // Only an active attestation is "verified"; pending has no attestation yet.
      verified: state === "verified",
      attestation:
        state === "pending"
          ? null
          : { recordHash, attester: ATTESTOR, timestamp, state },
    },
  ];
}

/** Deterministic fixtures: one record hash per lifecycle state. */
export const SANDBOX_FIXTURES: ReadonlyMap<string, SandboxFixture> = new Map([
  fixture("verified", "1", 1767225600),
  fixture("revoked", "2", 1767312000),
  fixture("archived", "3", 1767398400),
  fixture("pending", "4", 1767484800),
]);

export type SandboxAuth =
  | { mode: "production" }
  | { mode: "sandbox"; keyId: string }
  | { mode: "invalid" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Classifies a request by its bearer token. A token with the sandbox prefix
 * that is not configured is rejected outright rather than falling through to
 * production.
 */
export function resolveSandboxAuth(request: Request): SandboxAuth {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith(SANDBOX_KEY_PREFIX)) return { mode: "production" };

  const configured = (process.env.LAFIYA_SANDBOX_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.startsWith(SANDBOX_KEY_PREFIX));
  const presented = digest(token);
  const match = configured.some((k) => timingSafeEqual(digest(k), presented));
  return match
    ? { mode: "sandbox", keyId: presented.toString("hex").slice(0, 16) }
    : { mode: "invalid" };
}

export function getSandboxFixture(recordHash: string): SandboxFixture | null {
  return SANDBOX_FIXTURES.get(recordHash.toLowerCase()) ?? null;
}

/** Simulated webhook payload for a fixture, as a partner endpoint would receive it. */
export function buildSandboxWebhook(
  recordHash: string,
): Record<string, unknown> | null {
  const fx = getSandboxFixture(recordHash);
  if (!fx) return null;
  return {
    sandbox: true,
    type: `attestation.${fx.state}`,
    recordHash: recordHash.toLowerCase(),
    occurredAt: fx.attestation?.timestamp ?? 1767484800,
  };
}

const windows = new Map<string, { count: number; resetAt: number }>();

/** Sandbox-only fixed-window limiter, independent of the production table. */
export function checkSandboxRateLimit(keyId: string, now: number = Date.now()) {
  const current = windows.get(keyId);
  const window =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + SANDBOX_RATE_LIMIT.windowMs };
  window.count++;
  windows.set(keyId, window);
  return {
    allowed: window.count <= SANDBOX_RATE_LIMIT.limit,
    secondsRemaining: Math.ceil((window.resetAt - now) / 1000),
  };
}

/** Test helper. */
export function resetSandboxRateLimits(): void {
  windows.clear();
}
