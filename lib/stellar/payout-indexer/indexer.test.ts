import { describe, expect, it } from "vitest";

import { PayoutIndexer } from "./indexer";
import type {
  AttestationEvent,
  AttestationSource,
  EventPage,
  PayoutEvent,
  PayoutIndexerStore,
  PayoutSource,
  StreamName,
} from "./types";

const HASH = "ab".repeat(32);
const CHW = "GCHW";

const attestation: AttestationEvent = {
  recordHash: HASH,
  stellarAddress: CHW,
  attestedAt: "2026-07-30T12:00:00.000Z",
  transactionHash: "attestation-tx",
  ledger: 100,
};
const payout: PayoutEvent = {
  recordHash: HASH,
  stellarAddress: CHW,
  amountUsdc: "1.2500000",
  transactionHash: "payout-tx",
  paidAt: "2026-07-30T12:01:00.000Z",
  pagingToken: "200-1",
};

type Row = {
  status: "pending" | "paid";
  payoutTxHash: string | null;
};

class MemoryStore implements PayoutIndexerStore {
  cursors = new Map<StreamName, string>();
  rows = new Map<string, Row>();
  observations = new Map<string, PayoutEvent>();
  failAfterApply: number | null = null;
  applies = 0;

  async getCursor(stream: StreamName) {
    return this.cursors.get(stream) ?? null;
  }
  async saveCursor(stream: StreamName, cursor: string) {
    this.cursors.set(stream, cursor);
  }
  async applyAttestation(event: AttestationEvent) {
    this.maybeCrash();
    const observation = this.observations.get(event.recordHash);
    const existing = this.rows.get(event.recordHash);
    this.rows.set(event.recordHash, {
      status: observation || existing?.status === "paid" ? "paid" : "pending",
      payoutTxHash:
        observation?.transactionHash ?? existing?.payoutTxHash ?? null,
    });
    if (observation) this.observations.delete(event.recordHash);
    return observation ? "paid_from_observation" : "pending";
  }
  async applyPayout(event: PayoutEvent) {
    this.maybeCrash();
    const row = this.rows.get(event.recordHash);
    if (row) {
      this.rows.set(event.recordHash, {
        status: "paid",
        payoutTxHash: event.transactionHash,
      });
      return "paid";
    }
    this.observations.set(event.recordHash, event);
    return "awaiting_attestation";
  }
  private maybeCrash() {
    this.applies += 1;
    if (this.failAfterApply === this.applies)
      throw new Error("simulated crash");
  }
}

class StaticAttestations implements AttestationSource {
  constructor(private readonly page: EventPage<AttestationEvent>) {}
  async read() {
    return this.page;
  }
}
class StaticPayouts implements PayoutSource {
  constructor(private readonly page: EventPage<PayoutEvent>) {}
  async read() {
    return this.page;
  }
}

function indexer(
  store: MemoryStore,
  attestations: AttestationEvent[],
  payouts: PayoutEvent[],
) {
  return new PayoutIndexer(
    store,
    new StaticAttestations({ events: attestations, cursor: "att-cursor" }),
    new StaticPayouts({ events: payouts, cursor: "pay-cursor" }),
    1,
  );
}

describe("PayoutIndexer", () => {
  it("is idempotent when the same complete batch is processed twice", async () => {
    const store = new MemoryStore();
    const runner = indexer(store, [attestation], [payout]);
    await runner.runOnce();
    await runner.runOnce();

    expect([...store.rows]).toEqual([
      [HASH, { status: "paid", payoutTxHash: "payout-tx" }],
    ]);
    expect(store.observations.size).toBe(0);
  });

  it("replays a partial page after a crash without skipping or duplicating events", async () => {
    const second = { ...attestation, recordHash: "cd".repeat(32) };
    const store = new MemoryStore();
    store.failAfterApply = 2;

    await expect(
      indexer(store, [attestation, second], []).runOnce(),
    ).rejects.toThrow("simulated crash");
    expect(store.cursors.has("attestations")).toBe(false);

    store.failAfterApply = null;
    await indexer(store, [attestation, second], []).runOnce();
    expect([...store.rows.keys()].sort()).toEqual(
      [attestation.recordHash, second.recordHash].sort(),
    );
    expect(store.cursors.get("attestations")).toBe("att-cursor");
  });

  it("reconciles payout-before-attestation into one paid row", async () => {
    const store = new MemoryStore();
    await indexer(store, [], [payout]).runOnce();
    expect(store.observations.has(HASH)).toBe(true);

    await indexer(store, [attestation], []).runOnce();
    expect(store.rows.get(HASH)).toEqual({
      status: "paid",
      payoutTxHash: "payout-tx",
    });
    expect(store.observations.size).toBe(0);
  });

  it("reconciles attestation-before-payout into the same paid result", async () => {
    const store = new MemoryStore();
    await indexer(store, [attestation], []).runOnce();
    await indexer(store, [], [payout]).runOnce();

    expect(store.rows.get(HASH)).toEqual({
      status: "paid",
      payoutTxHash: "payout-tx",
    });
  });

  it("indexes events into the correct final state even when a page delivers them out of chronological order", async () => {
    // Simulate a retry / multi-RPC-provider scenario where a later-ledger
    // attestation is delivered before an earlier-ledger one, and a
    // higher-pagingToken payout arrives before a lower-pagingToken payout.
    const older = attestation; // ledger 100
    const newer: AttestationEvent = {
      ...attestation,
      recordHash: "ef".repeat(32),
      ledger: 105,
      transactionHash: "attestation-tx-newer",
    };
    const earlierPayout = payout; // pagingToken "200-1"
    const laterPayout: PayoutEvent = {
      ...payout,
      recordHash: newer.recordHash,
      pagingToken: "199-1",
      transactionHash: "payout-tx-newer",
    };

    const store = new MemoryStore();
    // Deliver out of order: newer attestation before older, later-pagingToken
    // payout before the earlier one.
    await indexer(
      store,
      [newer, older],
      [laterPayout, earlierPayout],
    ).runOnce();

    expect(store.rows.get(older.recordHash)).toEqual({
      status: "paid",
      payoutTxHash: earlierPayout.transactionHash,
    });
    expect(store.rows.get(newer.recordHash)).toEqual({
      status: "paid",
      payoutTxHash: laterPayout.transactionHash,
    });
    expect(store.observations.size).toBe(0);
  });

  it("does not create a duplicate payout record when the same payout event is delivered more than once", async () => {
    const store = new MemoryStore();
    // Attestation lands first so the row exists when the (duplicated) payout
    // events arrive.
    await indexer(store, [attestation], []).runOnce();

    // Same event delivered twice within one page, as can happen with
    // at-least-once delivery / RPC retries.
    await indexer(store, [], [payout, payout]).runOnce();

    expect([...store.rows.entries()]).toEqual([
      [HASH, { status: "paid", payoutTxHash: "payout-tx" }],
    ]);
    expect(store.rows.size).toBe(1);

    // Redelivering the identical event again in a later run must remain a
    // no-op on the final state (idempotent), not append another record.
    await indexer(store, [], [payout]).runOnce();
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(HASH)).toEqual({
      status: "paid",
      payoutTxHash: "payout-tx",
    });
  });
});
