import { describe, expect, it, vi } from "vitest";

import { PayoutIndexer } from "@/lib/stellar/payout-indexer/indexer";
import type {
  PayoutEvent,
  PayoutIndexerStore,
} from "@/lib/stellar/payout-indexer/types";
import { VerificationIndexer } from "@/lib/stellar/verification-indexer/indexer";
import type {
  FinalizedAttestationEvent,
  VerificationEvidenceStore,
} from "@/lib/stellar/verification-indexer/types";

import {
  formatFailure,
  runSeed,
  seedsToRun,
  type IndexerAdapter,
  type SimEvent,
} from "./harness";

vi.mock("@/lib/logging/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

function toFinalized(event: SimEvent): FinalizedAttestationEvent {
  return {
    eventId: event.id,
    intentId: `intent-${event.position}`,
    recordCommitment: event.amount.toString(16).padStart(64, "0"),
    attesterAddress: "GSIM",
    transactionHash: `tx-${event.position}`,
    ledgerSequence: event.position + 1,
    ledgerHash: `ledger-${event.position}`,
    eventIndex: 0,
    observedAt: "2026-01-01T00:00:00.000Z",
    finalizedAt: "2026-01-01T00:00:00.000Z",
    networkPassphraseHash: "a".repeat(64),
    contractId: "CSIM",
    contractVersion: "1.0.0",
    schemaVersion: 1,
    idempotencyKey: event.id,
  };
}

function fromFinalized(event: FinalizedAttestationEvent): SimEvent {
  return {
    id: event.eventId,
    position: event.ledgerSequence - 1,
    amount: parseInt(event.recordCommitment, 16),
  };
}

const verificationAdapter: IndexerAdapter = async (source, store) => {
  const evidence = {
    getCursor: () => store.getCursor(),
    getCheckpointLedger: async () => 1,
    applyFinalized: (event: FinalizedAttestationEvent) =>
      store.apply(fromFinalized(event)),
    quarantine: async (eventId: string, reason: string) => {
      throw new Error(`unexpected quarantine of ${eventId}: ${reason}`);
    },
    saveCursor: (cursor: string) => store.saveCursor(cursor),
  } as VerificationEvidenceStore;
  const events = {
    getRetentionWindow: async () => ({ oldestLedger: 0, latestLedger: 1e6 }),
    read: async (cursor: string | null) => {
      const page = await source.read(cursor);
      return { events: page.events.map(toFinalized), cursor: page.cursor };
    },
  };
  await new VerificationIndexer(evidence, events).runOnce();
};

const payoutAdapter: IndexerAdapter = async (source, store) => {
  const payouts = {
    getCursor: async (stream: string) =>
      stream === "payments" ? store.getCursor() : null,
    saveCursor: async (stream: string, cursor: string) => {
      if (stream === "payments") await store.saveCursor(cursor);
    },
    getLedgerCheckpoint: async () => null,
    updateLedgerCheckpoint: async () => {},
    applyAttestation: async () => {
      throw new Error("unexpected attestation");
    },
    applyPayout: async (event: PayoutEvent) => {
      await store.apply({
        id: event.pagingToken,
        position: event.ledger! - 1,
        amount: Number(event.amountUsdc),
      });
      return { decision: "paid", evidenceRecorded: true, reorgDetected: false };
    },
    getConflictingRecords: async () => [],
  } as unknown as PayoutIndexerStore;
  await new PayoutIndexer(
    payouts,
    { read: async () => ({ events: [], cursor: "0" }) },
    {
      read: async (cursor) => {
        const page = await source.read(cursor);
        return {
          cursor: page.cursor,
          events: page.events.map((event) => ({
            recordHash: event.id,
            stellarAddress: "GSIM",
            amountUsdc: String(event.amount),
            transactionHash: `tx-${event.position}`,
            paidAt: "2026-01-01T00:00:00.000Z",
            pagingToken: event.id,
            ledger: event.position + 1,
          })),
        };
      },
    },
    1,
  ).runOnce();
};

/** Known bug: the cursor is advanced before the page is committed. */
const cursorBeforeCommitAdapter: IndexerAdapter = async (source, store) => {
  const page = await source.read(await store.getCursor());
  await store.saveCursor(page.cursor);
  for (const event of page.events) await store.apply(event);
};

async function failures(adapter: IndexerAdapter, name: string) {
  const messages: string[] = [];
  for (const seed of seedsToRun()) {
    const result = await runSeed(adapter, seed);
    if (result.violations.length > 0)
      messages.push(formatFailure(name, result));
  }
  return messages;
}

describe("indexer deterministic simulation", () => {
  it("verification indexer upholds all invariants across seeded runs", async () => {
    const messages = await failures(verificationAdapter, "verification");
    expect(messages, messages.join("\n\n")).toEqual([]);
  });

  it("payout indexer upholds all invariants across seeded runs", async () => {
    const messages = await failures(payoutAdapter, "payout");
    expect(messages, messages.join("\n\n")).toEqual([]);
  });

  it("detects an injected cursor-advanced-before-commit bug", async () => {
    const messages = await failures(cursorBeforeCommitAdapter, "buggy");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toMatch(/saved before .* was committed/);
    expect(messages[0]).toMatch(/replay: SIM_SEED=\d+ npm run test:sim/);
  });
});
