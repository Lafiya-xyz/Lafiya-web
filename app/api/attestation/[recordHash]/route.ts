import { NextResponse } from "next/server";

import { setMockAttestationForTesting } from "@/lib/stellar/attestation";

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