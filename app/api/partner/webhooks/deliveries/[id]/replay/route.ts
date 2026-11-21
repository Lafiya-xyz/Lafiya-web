/**
 * Issue #937: replay one failed delivery.
 * POST /api/partner/webhooks/deliveries/<id>/replay
 *
 * The original idempotency key is preserved, the request is re-signed with
 * the endpoint's active secret, and replays are rate limited per endpoint.
 * The body is never persisted, so the caller supplies it again; it must hash
 * to the stored `requestBodySha256` or the replay is rejected.
 */

import { NextRequest, NextResponse } from "next/server";

import { authenticatePartnerKey } from "@/lib/security/partner-keys";
import {
  activeSecretHashes,
  bodyDigest,
  checkReplayRateLimit,
  getDelivery,
  replayDelivery,
} from "@/lib/webhooks/partner-deliveries";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const key = await authenticatePartnerKey(request);
  if (!key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const delivery = await getDelivery(key.partnerId, id);
  if (!delivery) {
    return NextResponse.json({ error: "delivery not found" }, { status: 404 });
  }

  const limit = await checkReplayRateLimit(delivery.endpointId);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "replay rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const rawBody = typeof body?.body === "string" ? body.body : null;
  if (rawBody === null) {
    return NextResponse.json({ error: "body must be a JSON string" }, { status: 400 });
  }
  if (bodyDigest(rawBody).sha256 !== delivery.requestBodySha256) {
    return NextResponse.json(
      { error: "body does not match the original delivery" },
      { status: 422 },
    );
  }

  const secrets = await activeSecretHashes(delivery.endpointId);
  if (secrets.length === 0) {
    return NextResponse.json({ error: "endpoint has no active secret" }, { status: 409 });
  }

  // The active secret is the first hash; the plaintext is not recoverable, so
  // the replay is signed with a fresh secret only if the caller supplies one.
  const suppliedSecret = typeof body?.secret === "string" ? body.secret : null;
  if (!suppliedSecret || !secrets.includes((await import("@/lib/webhooks/partner-deliveries")).hashSecret(suppliedSecret))) {
    return NextResponse.json({ error: "valid endpoint secret required" }, { status: 403 });
  }

  const replayed = await replayDelivery({ delivery, rawBody, secret: suppliedSecret });
  return NextResponse.json({ delivery: replayed }, { status: 201 });
}
