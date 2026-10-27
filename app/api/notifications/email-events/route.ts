import { NextResponse } from "next/server";

import { logWarn } from "@/lib/logging/logger";
import { recordEmailEvent } from "@/lib/notifications";
import { classifyEmailEvent, verifyWebhookSignature } from "@/lib/notifications/suppression";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Email provider bounce / complaint webhook (issue #802). The raw body is
 * HMAC-SHA256 signed with EMAIL_WEBHOOK_SECRET. A bad signature is rejected
 * and logged WITHOUT any payload content (addresses are PII).
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const signature =
    request.headers.get("x-webhook-signature") ?? request.headers.get("x-signature");
  if (!verifyWebhookSignature(raw, signature, process.env.EMAIL_WEBHOOK_SECRET)) {
    logWarn("notifications: rejected email webhook with invalid signature", {
      hasSignature: Boolean(signature),
      bytes: raw.length,
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const events = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
  let processed = 0;
  for (const raw of events) {
    const event = raw && typeof raw === "object" ? classifyEmailEvent(raw) : null;
    if (!event) continue;
    await recordEmailEvent(event);
    processed++;
  }
  return NextResponse.json({ processed });
}
