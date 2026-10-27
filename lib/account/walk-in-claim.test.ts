import { describe, expect, it } from "vitest";

import {
  ClaimError,
  hashClaimSecret,
  issueClaim,
  MAX_CLAIM_ATTEMPTS,
  pickWalkInFields,
  purgeExpiredClaims,
  redeemClaim,
  type PendingClaim,
  type WalkInClaimStore,
} from "./walk-in-claim";

function memoryStore() {
  const rows = new Map<
    string,
    PendingClaim & { owner: string | null; custodian: string | null }
  >();
  const store: WalkInClaimStore = {
    async insert(claim) {
      rows.set(claim.cardId, {
        ...claim,
        owner: null,
        custodian: claim.custodianId,
      });
    },
    async findByCodeHash(hash) {
      return [...rows.values()].find((r) => r.codeHash === hash) ?? null;
    },
    async incrementAttempts(cardId) {
      rows.get(cardId)!.attempts++;
    },
    async transferOwnership(cardId, patientId, now) {
      const r = rows.get(cardId);
      if (!r || r.claimedBy || r.expiresAt <= now) return false;
      Object.assign(r, {
        claimedBy: patientId,
        claimedAt: now,
        owner: patientId,
        custodian: null,
      });
      return true;
    },
    async purgeExpired(now) {
      let n = 0;
      for (const [id, r] of rows) {
        if (!r.claimedBy && r.expiresAt <= now) {
          rows.delete(id);
          n++;
        }
      }
      return n;
    },
  };
  return { rows, store };
}

const pepper = "test-pepper";

describe("walk-in claim codes", () => {
  it("stores only hashes and transfers ownership once", async () => {
    let now = 1_000;
    const { rows, store } = memoryStore();
    const deps = { store, pepper, clock: () => now, ttlMs: 10_000 };
    const { code } = await issueClaim(deps, "card-1", "chw-1");

    const row = rows.get("card-1")!;
    expect(row.codeHash).toBe(hashClaimSecret(code, pepper));
    expect(JSON.stringify(row)).not.toContain(code);

    now = 2_000;
    await expect(
      redeemClaim(deps, {
        code: code.toLowerCase(),
        patientId: "p-1",
        otpVerified: true,
      }),
    ).resolves.toEqual({ cardId: "card-1" });
    expect(row.owner).toBe("p-1");
    expect(row.custodian).toBeNull();

    await expect(
      redeemClaim(deps, { code, patientId: "p-2", otpVerified: true }),
    ).rejects.toEqual(new ClaimError("ALREADY_CLAIMED"));
  });

  it("requires a verified OTP", async () => {
    const { store } = memoryStore();
    const deps = { store, pepper };
    const { code } = await issueClaim(deps, "c", "chw");
    await expect(
      redeemClaim(deps, { code, patientId: "p", otpVerified: false }),
    ).rejects.toEqual(new ClaimError("OTP_NOT_VERIFIED"));
  });

  it("rejects expired codes", async () => {
    let now = 0;
    const { store } = memoryStore();
    const deps = { store, pepper, clock: () => now, ttlMs: 100 };
    const { code } = await issueClaim(deps, "c", "chw");
    now = 100;
    await expect(
      redeemClaim(deps, { code, patientId: "p", otpVerified: true }),
    ).rejects.toEqual(new ClaimError("EXPIRED"));
  });

  it("rate-limits wrong PIN attempts per claim", async () => {
    const { store } = memoryStore();
    const deps = { store, pepper };
    const { code, pin } = await issueClaim(deps, "c", "chw", { withPin: true });
    for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
      await expect(
        redeemClaim(deps, {
          code,
          pin: "000000x",
          patientId: "p",
          otpVerified: true,
        }),
      ).rejects.toEqual(new ClaimError("PIN_REQUIRED"));
    }
    await expect(
      redeemClaim(deps, { code, pin: pin!, patientId: "p", otpVerified: true }),
    ).rejects.toEqual(new ClaimError("TOO_MANY_ATTEMPTS"));
  });

  it("purges only unclaimed cards past expiry (fake clock)", async () => {
    let now = 0;
    const { rows, store } = memoryStore();
    const deps = { store, pepper, clock: () => now, ttlMs: 1_000 };
    const a = await issueClaim(deps, "a", "chw");
    await issueClaim(deps, "b", "chw");
    now = 500;
    await redeemClaim(deps, {
      code: a.code,
      patientId: "p",
      otpVerified: true,
    });
    await issueClaim(deps, "c", "chw");

    now = 999;
    expect(await purgeExpiredClaims(deps)).toBe(0);
    now = 1_000;
    expect(await purgeExpiredClaims(deps)).toBe(1);
    expect([...rows.keys()].sort()).toEqual(["a", "c"]);
    now = 1_500;
    expect(await purgeExpiredClaims(deps)).toBe(1);
    expect([...rows.keys()]).toEqual(["a"]);
  });

  it("keeps only allow-listed walk-in fields", () => {
    expect(
      pickWalkInFields({ name: "A", email: "x@y.z", allergies: [] }),
    ).toEqual({
      name: "A",
      allergies: [],
    });
  });
});
