import { NextResponse } from "next/server";

import { logWarn } from "@/lib/logging/logger";
import { applyDeliveryReceipt } from "@/lib/notifications";
import { normalizeStatus, verifyTermiiSignature } from "@/lib/notifications/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Termii delivery-receipt webhook (issue #803). Signed with TERMII_WEBHOOK_SECRET. */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get("x-termii-signature");
  if (!verifyTermiiSignature(raw, signature, process.env.TERMII_WEBHOOK_SECRET)) {
    logWarn("notifications: rejected Termii receipt with invalid signature", {
      hasSignature: Boolean(signature),
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const messageId = String(body.message_id ?? body.messageId ?? "");
  const state = normalizeStatus("termii", String(body.status ?? ""));
  if (!messageId || !state) {
    return NextResponse.json({ error: "unrecognized_receipt" }, { status: 422 });
  }
  const stored = await applyDeliveryReceipt("termii", messageId, state);
  // 200 even for unknown ids so the provider does not retry forever.
  return NextResponse.json({ state: stored ?? "unknown" });
}
