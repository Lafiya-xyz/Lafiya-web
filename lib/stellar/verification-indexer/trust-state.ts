import "server-only";

import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import type { ContractTrustState } from "./types";

/**
 * Current governance trust state of the attestation contract (issue #629).
 * Fails safe: if the state cannot be read, verification is reported as
 * degraded rather than silently trusted.
 */
export async function getContractTrustState(): Promise<
  ContractTrustState | "unknown"
> {
  try {
    const { data, error } = await createAdminClient()
      .from("attestation_contract_trust_state")
      .select("state")
      .maybeSingle();
    if (error) throw new Error("CONTRACT_TRUST_STATE_UNAVAILABLE");
    return data?.state ?? "trusted";
  } catch (error) {
    logError("Failed to read attestation contract trust state", error);
    return "unknown";
  }
}

/** True when verified badges must degrade to "temporarily unavailable". */
export async function isAttestationTrustDegraded(): Promise<boolean> {
  return (await getContractTrustState()) !== "trusted";
}
