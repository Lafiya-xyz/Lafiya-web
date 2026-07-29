import { NextResponse } from "next/server";

import { getAttestation, setMockAttestationForTesting } from "@/lib/stellar/attestation";

import { logError } from "@/lib/logging/logger";

const RECORD_HASH_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Read-only, unauthenticated lookup of an attestation by record hash. A
 * distinct Route Handler (rather than folded into the card page's Server
 * Component) because this is meant to be callable by things that aren't
 * this app's own pages — client-side polling, or lafiya-verifier later —
 * per README.md > Repository Structure.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ recordHash: string }> },
) {
  const { recordHash } = await params;

  if (!RECORD_HASH_PATTERN.test(recordHash)) {
    return NextResponse.json(
      { error: "recordHash must be a 64-character hex SHA-256 digest" },
      { status: 400 },
    );
  }

  try {
    const attestation = await getAttestation(recordHash);
    return NextResponse.json({
      verified: attestation !== null,
      attestation,
    });
  } catch (error) {
    logError("Failed to lookup attestation", error, {
      route: "/api/attestation/[recordHash]",
      recordHash,
    });
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

/**
 * Test-only seam: lets an out-of-process E2E/visual-regression test
 * register a mock attestation for a specific recordHash before visiting the
 * public card page (see setMockAttestationForTesting). Inert (404) unless
 * ALLOW_TEST_ATTESTATION_SEED=true, which only the Playwright webServer
 * config sets — never set in production.
 */
export async function POST(request: Request) {
  if (process.env.ALLOW_TEST_ATTESTATION_SEED !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { recordHash, attester, timestamp } = body;

  if (typeof recordHash !== "string" || recordHash.length !== 64) {
    return NextResponse.json(
      { error: "recordHash must be a 64-char hex string" },
      { status: 400 },
    );
  }

  setMockAttestationForTesting(recordHash, {
    recordHash,
    attester: attester ?? "GTESTATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  });

  return NextResponse.json({ ok: true });
}
