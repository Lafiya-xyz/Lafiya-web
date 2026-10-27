import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { getAttestation } from "@/lib/stellar/attestation";
import { checkRateLimit, getClientIp, recordFailure } from "@/lib/rate-limit";
import {
  authenticatePartnerKey,
  consumePartnerQuota,
  recordPartnerUsage,
} from "@/lib/security/partner-keys";

import { logError, logInfo } from "@/lib/logging/logger";

const RECORD_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ROUTE_CLASS = "attestation_lookup";
const ENDPOINT_TEMPLATE = "/api/attestation/[recordHash]";
const PARTNER_SCOPE = "attestation:read";

/**
 * Freshness budget (issue #792):
 * - max-age=60   → browsers/private caches may reuse for up to 60 s without
 *                  a revalidation request. Short enough that a newly issued
 *                  attestation is visible within 1 minute.
 * - stale-while-revalidate=30 → after max-age, the stale response may be
 *                  served for a further 30 s while a background fetch happens.
 *                  Only safe because the worst case here is a 90-second old
 *                  "not verified" that becomes "verified" — never the reverse
 *                  (a revoked attestation cannot go back to verified).
 * - private       → no CDN/shared cache; only the end-user's browser.
 *                  Attestation results are user-visible trust state and must
 *                  not be shared across users.
 * - Vary: Accept-Encoding → ensures compressed vs. uncompressed responses
 *                  get separate cache entries.
 */
const CACHE_CONTROL =
  "private, max-age=60, stale-while-revalidate=30";

type AttestationLookupOutcome =
  "invalid_request" | "rate_limited" | "verified" | "not_found" | "error" | "not_modified";

function latencyBucket(elapsedMs: number): string {
  if (elapsedMs < 100) return "under_100_ms";
  if (elapsedMs < 500) return "100_to_499_ms";
  if (elapsedMs < 2_000) return "500_to_1999_ms";
  return "2000_ms_or_more";
}

function lookupContext(outcome: AttestationLookupOutcome, startedAt: number) {
  return {
    routeClass: ROUTE_CLASS,
    outcome,
    latencyBucket: latencyBucket(Math.max(0, Date.now() - startedAt)),
  };
}

function logLookupCompleted(
  outcome: Exclude<AttestationLookupOutcome, "error">,
  startedAt: number,
) {
  logInfo("Attestation lookup completed", lookupContext(outcome, startedAt));
}

/**
 * Derive a strong ETag from the attestation response body.
 *
 * The ETag is a SHA-256 of the JSON-serialised response fields that affect
 * the semantics of the response: `verified`, `ledger` sequence, and the
 * attestation's attester + timestamp (if present). This means:
 * - A not-found → verified transition produces a new ETag.
 * - Repeated lookups against the same ledger with the same state return the
 *   same ETag (deterministic — no random nonce needed here).
 *
 * We deliberately exclude `rpcHost` from the hash so a change in which RPC
 * node answered does not invalidate an otherwise identical cached response.
 */
function deriveETag(body: {
  verified: boolean;
  attestation: { attester?: string; timestamp?: number } | null;
  ledger: { sequence?: number } | null;
}): string {
  const stable = JSON.stringify({
    v: body.verified,
    l: body.ledger?.sequence ?? null,
    a: body.attestation
      ? {
          attester: body.attestation.attester,
          timestamp: body.attestation.timestamp,
        }
      : null,
  });
  return `"${createHash("sha256").update(stable).digest("hex").slice(0, 32)}"`;
}

/**
 * Read-only, unauthenticated lookup of an attestation by record hash. A
 * distinct Route Handler (rather than folded into the card page's Server
 * Component) because this is meant to be callable by things that aren't
 * this app's own pages — client-side polling, or lafiya-verifier later —
 * per README.md > Repository Structure.
 *
 * --- Rate limiting (issue-03) ---
 * The *primary* defense against enumerating record hashes is the
 * commitment scheme itself: record_hash is now HMAC-keyed by a per-patient
 * 256-bit secret (lib/attestation/recordHash.ts), so brute-forcing a valid
 * hash is computationally infeasible regardless of request rate. The
 * per-instance limiter below is defense-in-depth on top of that, not the
 * primary control — a fully distributed, atomicity-correct rate limiter is
 * separately tracked in issues/issue-07-distributed-rate-limiting.md
 * (which explicitly scopes this route out of its own work); duplicating
 * that effort here would be out of scope for this issue.
 *
 * Keyed by IP only: there's no user/email identity on this route, and
 * keying by the guessed hash itself would let an attacker evade the limit
 * trivially by varying the hash every request. recordFailure is called on
 * every request (not just misses) — a single lucky guess must not reset an
 * attacker's counter the way a correct password does on sign-in.
 *
 * --- Ledger pinning (issue-561) ---
 * getAttestation returns a LedgerPinnedResult so the observed Soroban
 * ledger (and the RPC host that served it) is surfaced to consumers,
 * letting them reason about freshness and cross-check against indexers.
 *
 * --- Conditional requests and caching (issue #792) ---
 * Returns ETag, Cache-Control, and Vary headers on every 200 response.
 * Supports If-None-Match: returns 304 without hitting RPC when the client's
 * cached ETag matches. The ETag is derived from attestation state + ledger
 * sequence; it changes whenever the verified status or ledger changes, so
 * stale "not verified" responses are never served beyond the freshness budget.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ recordHash: string }> },
) {
  // Issue #809: requests carrying a partner key are metered per key and
  // enforced against that key's quotas instead of the anonymous IP limiter.
  if (!request.headers.get("authorization")) {
    return lookup(context);
  }
  const key = await authenticatePartnerKey(request);
  if (!key) {
    return NextResponse.json({ error: "invalid or expired API key" }, { status: 401 });
  }
  if (!key.scopes.includes(PARTNER_SCOPE)) {
    await recordPartnerUsage(key.id, ENDPOINT_TEMPLATE, 403);
    return NextResponse.json({ error: `API key lacks scope ${PARTNER_SCOPE}` }, { status: 403 });
  }
  const quota = await consumePartnerQuota(key);
  const response = quota.allowed
    ? await lookup(context, { skipIpLimit: true })
    : NextResponse.json({ error: "Partner quota exceeded." }, { status: 429 });
  for (const [name, value] of Object.entries(quota.headers)) {
    response.headers.set(name, value);
  }
  await recordPartnerUsage(key.id, ENDPOINT_TEMPLATE, response.status);
  return response;
}

async function lookup(
  { params }: { params: Promise<{ recordHash: string }> },
  { skipIpLimit = false }: { skipIpLimit?: boolean } = {},
) {
  const startedAt = Date.now();
  const { recordHash } = await params;

  if (!RECORD_HASH_PATTERN.test(recordHash)) {
    logLookupCompleted("invalid_request", startedAt);
    return NextResponse.json(
      { error: "recordHash must be a 64-character hex SHA-256 digest" },
      { status: 400 },
    );
  }

  const sandbox = resolveSandboxAuth(request);
  if (sandbox.mode === "invalid") {
    return NextResponse.json({ error: "Invalid sandbox API key" }, { status: 401 });
  }
  if (sandbox.mode === "sandbox") {
    const sandboxHeaders = { [SANDBOX_HEADER]: "true" };
    const limit = checkSandboxRateLimit(sandbox.keyId);
    if (!limit.allowed) {
      return NextResponse.json(
        { sandbox: true, error: "Too many requests. Please try again later.", secondsRemaining: limit.secondsRemaining },
        { status: 429, headers: sandboxHeaders },
      );
    }
    const fixture = getSandboxFixture(recordHash);
    return NextResponse.json(
      {
        sandbox: true,
        verified: fixture?.verified ?? false,
        state: fixture?.state ?? null,
        attestation: fixture?.attestation ?? null,
        ledger: null,
        rpcHost: null,
        simulatedWebhook: buildSandboxWebhook(recordHash),
      },
      { headers: sandboxHeaders },
    );
  }

  try {
    const ip = skipIpLimit ? null : await getClientIp();
    const rateLimitKey = `attestation-lookup:${ip}`;

    const limitCheck = ip
      ? await checkRateLimit(rateLimitKey)
      : { allowed: true, secondsRemaining: 0 };
    if (!limitCheck.allowed) {
      logLookupCompleted("rate_limited", startedAt);
      return NextResponse.json(
        {
          error: "Too many requests. Please try again later.",
          secondsRemaining: limitCheck.secondsRemaining,
        },
        { status: 429 },
      );
    }

    if (ip) await recordFailure(rateLimitKey);

    const pinned = await getAttestation(recordHash);
    const attestation = pinned?.value ?? null;
    const outcome = attestation === null ? "not_found" : "verified";

    const body = {
      verified: attestation !== null,
      attestation,
      ledger: pinned?.ledger ?? null,
      rpcHost: pinned?.rpcHost ?? null,
    };

    const etag = deriveETag(body);

    // Conditional request: check If-None-Match before sending the body.
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      logLookupCompleted("not_modified", startedAt);
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": CACHE_CONTROL,
          Vary: "Accept-Encoding",
        },
      });
    }

    logLookupCompleted(outcome, startedAt);
    return NextResponse.json(body, {
      headers: {
        ETag: etag,
        "Cache-Control": CACHE_CONTROL,
        Vary: "Accept-Encoding",
      },
    });
  } catch {
    logError(
      "Attestation lookup failed",
      new Error("ATTESTATION_LOOKUP_FAILED"),
      lookupContext("error", startedAt),
    );
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
