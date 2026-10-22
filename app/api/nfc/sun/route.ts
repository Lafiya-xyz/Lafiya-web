import { NextResponse } from "next/server";

import { memoryCounterStore, verifySunMessage } from "@/lib/nfc/sun";

/**
 * ROUTE: GET /api/nfc/sun?picc=…&cmac=…
 *
 * Spike verifier for NTAG 424 DNA SUN messages (issue #772). Returns 501
 * when `NFC_SUN_MASTER_KEY` (32 hex chars) is unset. The replay counter is
 * per-process in this prototype; production needs the shared table described
 * in docs/ntag424-sun-spike.md.
 */
const counters = memoryCounterStore();

export async function GET(request: Request) {
  const keyHex = process.env.NFC_SUN_MASTER_KEY;
  if (!keyHex || !/^[0-9a-fA-F]{32}$/.test(keyHex)) {
    return NextResponse.json(
      { error: "SUN verification is not configured." },
      { status: 501 },
    );
  }
  const params = new URL(request.url).searchParams;
  const result = await verifySunMessage(
    { picc: params.get("picc") ?? "", cmac: params.get("cmac") ?? "" },
    Buffer.from(keyHex, "hex"),
    counters,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason },
      {
        status: result.reason === "REPLAYED" ? 409 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return NextResponse.json(
    { valid: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
