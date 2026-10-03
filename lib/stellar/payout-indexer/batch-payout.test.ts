import { describe, expect, it } from "vitest";
import { bisectAndRetry, type PayoutRecipient } from "./batch-payout";

function makeRecipients(n: number): PayoutRecipient[] {
  return Array.from({ length: n }, (_, i) => ({
    obligationId: `obligation-${i}`,
    eligibilityKey: `key-${i}`,
    recipientAddress: `GADDRESS${i}`,
    amountUsdc: "10.0000000",
  }));
}

/** Deterministic PRNG so property runs are reproducible without adding a new test dependency. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("bisectAndRetry", () => {
  it("quarantines only the single bad recipient in a batch of good ones", async () => {
    const recipients = makeRecipients(10);
    const badIndex = 4;
    const submitted: PayoutRecipient[][] = [];

    const result = await bisectAndRetry(
      recipients,
      async (batch) => {
        submitted.push(batch);
        const containsBad = batch.some((r) => r.obligationId === recipients[badIndex].obligationId);
        return containsBad ? { ok: false, operationCodes: ["op_no_destination"] } : { ok: true };
      },
      async () => {},
    );

    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0].recipient.obligationId).toBe(recipients[badIndex].obligationId);
    expect(result.retryable).toHaveLength(9);
  });

  it("property: for any single failure position in batches up to 100, exactly one recipient is quarantined and no recipient appears twice (no double payment)", async () => {
    const rand = mulberry32(42);

    for (let trial = 0; trial < 50; trial++) {
      const size = 1 + Math.floor(rand() * 100);
      const recipients = makeRecipients(size);
      const badIndex = Math.floor(rand() * size);

      const seenInSuccessfulSubmit = new Set<string>();

      const result = await bisectAndRetry(
        recipients,
        async (batch) => {
          const containsBad = batch.some((r) => r.obligationId === recipients[badIndex].obligationId);
          if (containsBad) {
            return { ok: false, operationCodes: ["op_underfunded"] };
          }
          for (const r of batch) {
            if (seenInSuccessfulSubmit.has(r.obligationId)) {
              throw new Error(`double payment detected for ${r.obligationId}`);
            }
            seenInSuccessfulSubmit.add(r.obligationId);
          }
          return { ok: true };
        },
        async () => {},
      );

      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0].recipient.obligationId).toBe(recipients[badIndex].obligationId);
      expect(result.retryable.length + result.quarantined.length).toBe(size);

      const allIds = [...result.retryable.map((r) => r.obligationId), ...result.quarantined.map((q) => q.recipient.obligationId)];
      expect(new Set(allIds).size).toBe(allIds.length);
    }
  });

  it("succeeds with zero quarantines when every recipient is payable", async () => {
    const recipients = makeRecipients(100);
    const result = await bisectAndRetry(
      recipients,
      async () => ({ ok: true }),
      async () => {
        throw new Error("quarantine should not be called");
      },
    );
    expect(result.quarantined).toHaveLength(0);
    expect(result.retryable).toHaveLength(100);
  });
});
