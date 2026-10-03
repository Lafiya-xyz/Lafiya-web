"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  digestCapability,
  isCapabilityToken,
} from "@/lib/emergency/capability";
import {
  CARD_PIN_COOKIE,
  CARD_PIN_PATTERN,
  CARD_PIN_UNLOCK_SECONDS,
  createUnlockToken,
  digestUnlockToken,
  verifyCardPin,
} from "@/lib/emergency/card-pin";
import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

type PinOutcome = "pin_success" | "pin_failure" | "pin_locked";

async function recordPinEvent(capabilityId: string, outcome: PinOutcome) {
  try {
    await createAdminClient().rpc("record_card_access_event", {
      p_capability_id: capabilityId,
      p_access_kind: "capability",
      p_outcome: outcome,
    });
  } catch (error) {
    logError("Failed to record card PIN access event", error, {
      route: "/card/c/[token] (action: submitCardPin)",
    });
  }
}

/**
 * Issue #631: verifies the printed card PIN. A plain POST form (no JS
 * needed). Each attempt is reserved in the database before the hash is
 * checked, so at most five wrong PINs can be tried per capability. A correct
 * PIN sets a 15-minute, httpOnly unlock cookie scoped to this card path;
 * only its digest is stored.
 */
export async function submitCardPin(formData: FormData): Promise<void> {
  const token = formData.get("token");
  const pin = formData.get("pin");
  if (typeof token !== "string" || !isCapabilityToken(token)) notFound();
  const path = `/card/c/${token}`;
  if (typeof pin !== "string" || !CARD_PIN_PATTERN.test(pin)) {
    redirect(`${path}?pin=invalid`);
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("begin_card_pin_attempt", {
    p_token_digest: digestCapability(token),
  });
  if (error) {
    logError("Failed to start card PIN attempt", new Error("PIN_UNAVAILABLE"), {
      route: "/card/c/[token] (action: submitCardPin)",
    });
    redirect(`${path}?pin=unavailable`);
  }
  const attempt = data?.[0];
  if (!attempt) redirect(path);
  if (!attempt.allowed || !attempt.pin_hash) {
    await recordPinEvent(attempt.capability_id, "pin_locked");
    redirect(`${path}?pin=locked`);
  }

  if (!(await verifyCardPin(pin, attempt.pin_hash))) {
    await recordPinEvent(attempt.capability_id, "pin_failure");
    redirect(`${path}?pin=invalid`);
  }

  const unlockToken = createUnlockToken();
  const { error: unlockError } = await admin.rpc("complete_card_pin_success", {
    p_capability_id: attempt.capability_id,
    p_unlock_digest: digestUnlockToken(unlockToken),
    p_unlock_expires_at: new Date(
      Date.now() + CARD_PIN_UNLOCK_SECONDS * 1000,
    ).toISOString(),
  });
  if (unlockError) redirect(`${path}?pin=unavailable`);
  (await cookies()).set(CARD_PIN_COOKIE, unlockToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path,
    maxAge: CARD_PIN_UNLOCK_SECONDS,
  });
  await recordPinEvent(attempt.capability_id, "pin_success");
  redirect(path);
}
