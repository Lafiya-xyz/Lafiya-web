import "server-only";

import { cookies } from "next/headers";

import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  CARD_PIN_COOKIE,
  digestUnlockToken,
  PIN_GATEABLE_FIELDS,
} from "./card-pin";

export type CapabilityPinGate = {
  /** Fields to withhold from this render (empty when unlocked). */
  withheld: string[];
  /** Whether a PIN form can unlock them. */
  canUnlock: boolean;
  locked: boolean;
  unlocked: boolean;
};

// Fail closed: if the gate cannot be read, every gateable field is withheld.
const FAIL_CLOSED: CapabilityPinGate = {
  withheld: [...PIN_GATEABLE_FIELDS],
  canUnlock: false,
  locked: false,
  unlocked: false,
};

/** Issue #631: PIN gate for a capability card render. */
export async function getCapabilityPinGate(
  capabilityId: string,
): Promise<CapabilityPinGate> {
  try {
    const unlockToken = (await cookies()).get(CARD_PIN_COOKIE)?.value;
    const { data, error } = await createAdminClient().rpc("get_card_pin_gate", {
      p_capability_id: capabilityId,
      p_unlock_digest: unlockToken ? digestUnlockToken(unlockToken) : "",
    });
    const gate = data?.[0];
    if (error || !gate) throw new Error("CARD_PIN_GATE_UNAVAILABLE");
    if (gate.gated_fields.length === 0 || gate.unlocked) {
      return {
        withheld: [],
        canUnlock: false,
        locked: false,
        unlocked: gate.unlocked && gate.gated_fields.length > 0,
      };
    }
    return {
      withheld: gate.gated_fields,
      canUnlock: gate.has_pin && !gate.locked,
      locked: gate.locked,
      unlocked: false,
    };
  } catch (error) {
    logError("Failed to read card PIN gate", error, {
      route: "/card/c/[token]",
    });
    return FAIL_CLOSED;
  }
}

/** Legacy UUID links have no PIN: gated fields are always withheld. */
export async function getLegacyPinGatedFields(
  cardId: string,
): Promise<string[]> {
  try {
    const { data, error } = await createAdminClient().rpc(
      "get_legacy_card_pin_gated_fields",
      { p_card_id: cardId },
    );
    if (error) throw new Error("CARD_PIN_GATE_UNAVAILABLE");
    return data ?? [];
  } catch (error) {
    logError("Failed to read card PIN gate", error, { route: "/card/[id]" });
    return [...PIN_GATEABLE_FIELDS];
  }
}
