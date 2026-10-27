import { NextResponse } from "next/server";

import { logWarn } from "@/lib/logging/logger";
import { applyDeliveryReceipt } from "@/lib/notifications";
import { normalizeStatus, verifyTwilioSignature } from "@/lib/notifications/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Twilio status-callback webhook (issue #803). Verified with
 * X-Twilio-Signature against TWILIO_STATUS_CALLBACK_URL (the public URL
 * Twilio was given — request.url may be an internal address behind a proxy).
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  const url = process.env.TWILIO_STATUS_CALLBACK_URL ?? request.url;
  const signature = request.headers.get("x-twilio-signature");
  if (!verifyTwilioSignature(url, params, signature, process.env.TWILIO_AUTH_TOKEN)) {
    logWarn("notifications: rejected Twilio receipt with invalid signature", {
      hasSignature: Boolean(signature),
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const messageId = params.MessageSid ?? params.SmsSid;
  const state = normalizeStatus("twilio", params.MessageStatus ?? params.SmsStatus ?? "");
  if (!messageId || !state) {
    return NextResponse.json({ error: "unrecognized_receipt" }, { status: 422 });
  }
  const stored = await applyDeliveryReceipt("twilio", messageId, state);
  return NextResponse.json({ state: stored ?? "unknown" });
}
