import { describe, expect, it } from "vitest";

import { VerificationIndexer } from "./indexer";
import type {
  FinalizedAttestationEvent,
  VerificationEvidenceStore,
  VerificationEventSource,
} from "./types";

const event: FinalizedAttestationEvent = {
  eventId: "event-1",
  intentId: "intent-1",
  recordCommitment: "b".repeat(64),
  attesterAddress: "GEXAMPLE",
  transactionHash: "transaction-1",
  ledgerSequence: 100,
  ledgerHash: "ledger-hash",
  eventIndex: 0,
  observedAt: "2026-08-21T00:00:00.000Z",
  finalizedAt: "2026-08-21T00:01:00.000Z",
  networkPassphraseHash: "a".repeat(64),
  contractId: "CEXAMPLE",
  contractVersion: "1.0.0",
  schemaVersion: 1,
  idempotencyKey: "key-1",
};

class Store implements VerificationEvidenceStore {
  cursor: string | null = null;
  applied = new Set<string>();
  quarantined = new Set<string>();
  failAfterApply = false;

  async getCursor() {
    return this.cursor;
  }
  async applyFinalized(input: FinalizedAttestationEvent) {
    this.applied.add(input.eventId);
    if (this.failAfterApply) throw new Error("crash after database apply");
  }
  async quarantine(eventId: string) {
    this.quarantined.add(eventId);
  }
  async saveCursor(cursor: string) {
    this.cursor = cursor;
  }
}

class Source implements VerificationEventSource {
  constructor(private readonly events: FinalizedAttestationEvent[]) {}
  async read() {
    return { events: this.events, cursor: "cursor-1" };
  }
}

describe("VerificationIndexer", () => {
  it("replays after a crash without advancing the cursor or multiplying effects", async () => {
    const store = new Store();
    store.failAfterApply = true;
    const indexer = new VerificationIndexer(store, new Source([event]));
    await expect(indexer.runOnce()).rejects.toThrow(
      "crash after database apply",
    );
    expect(store.cursor).toBeNull();
    store.failAfterApply = false;
    await indexer.runOnce();
    expect(store.applied).toEqual(new Set([event.eventId]));
    expect(store.cursor).toBe("cursor-1");
  });

  it("durably quarantines malformed input and advances beyond it", async () => {
    const store = new Store();
    await new VerificationIndexer(
      store,
      new Source([
        { ...event, eventId: "poison", networkPassphraseHash: "wrong" },
      ]),
    ).runOnce();
    expect(store.quarantined).toEqual(new Set(["poison"]));
    expect(store.cursor).toBe("cursor-1");
  });
});
