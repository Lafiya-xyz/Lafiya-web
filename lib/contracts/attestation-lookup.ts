/**
 * Issue #941: consumer-driven contract (Pact) surface for the attestation
 * lookup API consumed by `lafiya-verifier` and sandbox partners.
 *
 * This module is the single source of truth for the response shape those
 * consumers depend on. The route handler builds its body through
 * `buildAttestationLookupBody`, and the Pact consumer/provider tests assert
 * against the same builder, so removing or renaming a consumed field breaks
 * CI instead of a partner integration.
 *
 * Never carries patient data — only a record hash, an attester identity and a
 * timestamp (see lib/attestation/types.ts).
 */

import type { Attestation } from "@/lib/attestation/types";

/** Fields the verifier tool and sandbox partners consume. */
export const ATTESTATION_LOOKUP_CONTRACT_FIELDS = [
  "verified",
  "attestation",
  "ledger",
  "rpcHost",
] as const;

export type AttestationLookupBody = {
  verified: boolean;
  attestation: Attestation | null;
  ledger: { sequence: number } | null;
  rpcHost: string | null;
};

export type SandboxAttestationLookupBody = AttestationLookupBody & {
  sandbox: true;
  state: string | null;
  simulatedWebhook: Record<string, unknown> | null;
};

export function buildAttestationLookupBody(input: {
  attestation: Attestation | null;
  ledger?: { sequence: number } | null;
  rpcHost?: string | null;
}): AttestationLookupBody {
  return {
    verified: input.attestation !== null,
    attestation: input.attestation,
    ledger: input.ledger ?? null,
    rpcHost: input.rpcHost ?? null,
  };
}

export function buildSandboxAttestationLookupBody(input: {
  state: string | null;
  attestation: Attestation | null;
  simulatedWebhook: Record<string, unknown> | null;
}): SandboxAttestationLookupBody {
  return {
    sandbox: true,
    ...buildAttestationLookupBody({ attestation: input.attestation }),
    state: input.state,
    simulatedWebhook: input.simulatedWebhook,
  };
}
