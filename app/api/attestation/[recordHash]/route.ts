import { NextResponse } from "next/server";

import { getAttestation } from "@/lib/stellar/attestation";
import { checkRateLimit, getClientIp, recordFailure } from "@/lib/rate-limit";

import { logError, logInfo } from "@/lib/logging/logger";

const RECORD_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ROUTE_CLASS = "attestation_lookup";

type AttestationLookupOutcome =
  "invalid_request" | "rate_limited" | "verified" | "not_found" | "error";

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
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recordHash: string }> },
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

  try {
    const ip = await getClientIp();
    const rateLimitKey = `attestation-lookup:${ip}`;

    const limitCheck = await checkRateLimit(rateLimitKey);
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

    await recordFailure(rateLimitKey);

    const attestation = await getAttestation(recordHash);
    logLookupCompleted(
      attestation === null ? "not_found" : "verified",
      startedAt,
    );
    return NextResponse.json({
      verified: attestation !== null,
      attestation,
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
