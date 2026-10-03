import { logError, logInfo } from "@/lib/logging/logger";

import type {
  ContractAdminEvent,
  ContractAdminEventSource,
  ContractGovernanceStore,
  ContractTrustStatus,
  OperatorAlert,
  OperatorAlerter,
} from "./types";

const WASM_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeWasmHash(value: string): string {
  return value.trim().toLowerCase();
}

export function isApprovedWasmHash(
  wasmHash: string | undefined,
  approved: ReadonlySet<string>,
): boolean {
  if (!wasmHash) return false;
  const normalized = normalizeWasmHash(wasmHash);
  return WASM_HASH_PATTERN.test(normalized) && approved.has(normalized);
}

const UNKNOWN_CODE: ContractTrustStatus = {
  state: "needs_review",
  wasmHash: null,
  reasonCode: "UNAPPROVED_WASM_HASH",
};

/** Default alert sink: a stable, value-free error log that Sentry picks up. */
export const logOperatorAlerter: OperatorAlerter = {
  async alert(alert) {
    logError(
      "Attestation contract governance alert",
      new Error(`ATTESTATION_GOVERNANCE_${alert.code}`),
      {
        contractId: alert.contractId,
        eventId: alert.eventId,
        ...(alert.wasmHash ? { wasmHash: alert.wasmHash } : {}),
      },
    );
  },
};

function alertFor(event: ContractAdminEvent): OperatorAlert["code"] | null {
  switch (event.kind) {
    case "admin_transfer":
      return "ADMIN_TRANSFERRED";
    case "pause":
      return "CONTRACT_PAUSED";
    case "allowlist_change":
      return "ALLOWLIST_CHANGED";
    default:
      return null;
  }
}

/**
 * Indexes attestation-contract admin events (WASM upgrades, admin
 * transfers, allowlist changes, pause/unpause) and fails safe: an upgrade to
 * a WASM hash outside the approved allowlist moves trust to "needs_review",
 * which degrades every verified badge to "verification temporarily
 * unavailable" until an operator approves the hash. Like the attestation
 * indexer, the cursor is saved only after every event has been recorded.
 */
export class ContractGovernanceMonitor {
  private readonly approved: ReadonlySet<string>;

  constructor(
    private readonly store: ContractGovernanceStore,
    private readonly source: ContractAdminEventSource,
    approvedWasmHashes: readonly string[],
    private readonly alerter: OperatorAlerter = logOperatorAlerter,
  ) {
    this.approved = new Set(approvedWasmHashes.map(normalizeWasmHash));
  }

  /** Trust implied by the running code alone (ignoring pause). */
  private codeTrust(wasmHash: string | null): ContractTrustStatus {
    return !wasmHash || isApprovedWasmHash(wasmHash, this.approved)
      ? { state: "trusted", wasmHash, reasonCode: null }
      : { state: "needs_review", wasmHash, reasonCode: "UNAPPROVED_WASM_HASH" };
  }

  async runOnce(): Promise<{
    recorded: number;
    trust: ContractTrustStatus;
    cursor: string;
  }> {
    try {
      const cursor = await this.store.getCursor();
      const page = await this.source.read(cursor);
      const previous = await this.store.getTrustStatus();
      let paused = previous?.state === "paused";
      // Re-evaluated every run, so an operator approving a hash (adding it
      // to the allowlist) restores trust without a new on-chain event.
      let code =
        previous?.reasonCode === "UNAPPROVED_WASM_HASH" && !previous.wasmHash
          ? UNKNOWN_CODE
          : this.codeTrust(previous?.wasmHash ?? null);

      for (const event of page.events) {
        await this.store.recordAdminEvent(event);
        if (event.kind === "wasm_upgrade") {
          // An upgrade whose new hash cannot be read is treated as unapproved.
          code = event.wasmHash
            ? this.codeTrust(normalizeWasmHash(event.wasmHash))
            : UNKNOWN_CODE;
          if (code.state === "needs_review") {
            await this.alerter.alert({
              code: "UNAPPROVED_WASM_HASH",
              contractId: event.contractId,
              eventId: event.eventId,
              ...(code.wasmHash ? { wasmHash: code.wasmHash } : {}),
            });
          }
          continue;
        }
        if (event.kind === "pause") paused = true;
        if (event.kind === "unpause") paused = false;
        const alertCode = alertFor(event);
        if (alertCode) {
          await this.alerter.alert({
            code: alertCode,
            contractId: event.contractId,
            eventId: event.eventId,
          });
        }
      }

      // An unapproved upgrade outranks a pause: it needs operator review
      // even after the contract is unpaused.
      const trust: ContractTrustStatus =
        code.state === "needs_review" || !paused
          ? code
          : {
              state: "paused",
              wasmHash: code.wasmHash,
              reasonCode: "CONTRACT_PAUSED",
            };

      await this.store.setTrustStatus(trust);
      await this.store.saveCursor(page.cursor);
      logInfo("Contract governance monitor run completed", {
        recorded: page.events.length,
        trust: trust.state,
      });
      return { recorded: page.events.length, trust, cursor: page.cursor };
    } catch (error) {
      logError("Contract governance monitor run failed", error);
      throw error;
    }
  }
}
