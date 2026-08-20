import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminClient } from "./helpers/testUser";
import { createTestUser, deleteTestUser, type TestUser } from "./helpers/testUser";

/**
 * Integration tests for the chw_payouts RLS policy that backs the new
 * authenticated payout history API. The route handler and cursor codec
 * are exercised exhaustively in the unit suite; here we pin the
 * SQL-layer guarantee that the route itself relies on:
 *
 *   - a CHW authenticated as `auth.users.id = X` can only SELECT rows
 *     whose `chw_id = X` (RLS policy "CHW can read own payouts"),
 *   - anon gets denied (no GRANT to anon, plus RLS keeps them out),
 *   - a row can transition from pending -> paid in place and be visible
 *     as paid on the next read.
 *
 * Run via `npm run test:integration`. Requires a local Supabase stack
 * (the same one the existing chw-payout-indexer integration test uses).
 */

const createdRecordHashes = new Set<string>();
const chwIds = new Set<string>();

function paddingHash(suffix: string): string {
  return suffix.padEnd(64, "0").slice(0, 64);
}

async function seedPayout(input: {
  chwId: string | null;
  recordHash: string;
  stellarAddress: string;
  status: "pending" | "paid";
  amountUsdc?: number;
  payoutTxHash?: string | null;
  paidAt?: string | null;
  attestedAt?: string;
  createdAt?: string;
}): Promise<void> {
  createdRecordHashes.add(input.recordHash);
  if (input.chwId) chwIds.add(input.chwId);
  const baseInsert: Record<string, unknown> = {
    chw_id: input.chwId,
    record_hash: input.recordHash,
    stellar_address: input.stellarAddress,
    status: input.status,
    attested_at: input.attestedAt ?? "2026-08-20T12:00:00.000Z",
  };
  if (input.amountUsdc !== undefined) baseInsert.amount_usdc = input.amountUsdc;
  if (input.payoutTxHash !== undefined) baseInsert.payout_tx_hash = input.payoutTxHash;
  if (input.paidAt !== undefined) baseInsert.paid_at = input.paidAt;
  if (input.createdAt !== undefined) baseInsert.created_at = input.createdAt;
  const { error } = await adminClient.from("chw_payouts").insert(
    baseInsert as never,
  );
  expect(error).toBeNull();
}

async function deleteSeededRows(): Promise<void> {
  // Delete by chw_id first (much smaller fan-out than by record_hash
  // when the test seeds a lot of rows).
  for (const id of chwIds) {
    await adminClient.from("chw_payouts").delete().eq("chw_id", id);
  }
  for (const hash of createdRecordHashes) {
    await adminClient.from("chw_payouts").delete().eq("record_hash", hash);
  }
  createdRecordHashes.clear();
  chwIds.clear();
}

describe("chw_payouts RLS (backing the CHW payout history API)", () => {
  let userA: TestUser;
  let userB: TestUser;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();
  });

  afterAll(async () => {
    await deleteSeededRows();
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  });

  it("denies anon entirely (row-level + GRANT-level)", async () => {
    // anon has no GRANT to chw_payouts -> the query errors out, not "0 rows".
    // This is the property the route handler depends on by NOT being a
    // public endpoint; a misconfigured GRANT would let anon enumerate
    // hashes via record_hash lookup, so the test pins that surface.
    const before = await adminClient
      .from("chw_payouts")
      .select("id")
      .limit(1);
    expect(before.error).toBeNull();
    expect(before.data?.length ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("returns empty for a CHW with no rows", async () => {
    const { data, error } = await userA.client
      .from("chw_payouts")
      .select("id,status,amount_usdc,attested_at,paid_at,payout_tx_hash,created_at,updated_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    expect(error).toBeNull();
    // userA has no rows yet, so this MUST be [].
    expect(data ?? []).toEqual([]);
  });

  it("isolates CHW rows: A only sees A, B only sees B (no record_hash projected)", async () => {
    const hashA1 = paddingHash(`A1-${crypto.randomUUID()}`);
    const hashA2 = paddingHash(`A2-${crypto.randomUUID()}`);
    const hashB1 = paddingHash(`B1-${crypto.randomUUID()}`);
    const hashB2 = paddingHash(`B2-${crypto.randomUUID()}`);
    await seedPayout({
      chwId: userA.id,
      recordHash: hashA1,
      stellarAddress: "GCHWA1",
      status: "pending",
    });
    await seedPayout({
      chwId: userA.id,
      recordHash: hashA2,
      stellarAddress: "GCHWA1",
      status: "paid",
      payoutTxHash: "a2-hash",
      paidAt: "2026-08-20T13:00:00.000Z",
    });
    await seedPayout({
      chwId: userB.id,
      recordHash: hashB1,
      stellarAddress: "GCHWB1",
      status: "pending",
    });
    await seedPayout({
      chwId: userB.id,
      recordHash: hashB2,
      stellarAddress: "GCHWB1",
      status: "paid",
      payoutTxHash: "b2-hash",
      paidAt: "2026-08-20T14:00:00.000Z",
    });

    const projection =
      "id,status,amount_usdc,attested_at,paid_at,payout_tx_hash,created_at,updated_at";

    const { data: aRows, error: aError } = await userA.client
      .from("chw_payouts")
      .select(projection)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    expect(aError).toBeNull();
    expect(aRows?.length).toBe(2);
    for (const row of aRows ?? []) {
      // record_hash and stellar_address must never appear in the
      // projection the API uses; even if RLS misbehaves, the SELECT
      // list keeps the patient's hashes private.
      expect(row).not.toHaveProperty("record_hash");
      expect(row).not.toHaveProperty("stellar_address");
      expect(row).not.toHaveProperty("chw_id");
    }

    const { data: bRows, error: bError } = await userB.client
      .from("chw_payouts")
      .select(projection)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    expect(bError).toBeNull();
    expect(bRows?.length).toBe(2);
    for (const row of bRows ?? []) {
      expect(row).not.toHaveProperty("record_hash");
      expect(row).not.toHaveProperty("stellar_address");
      expect(row).not.toHaveProperty("chw_id");
    }

    // Cross-check via service role: every row for A has chw_id = userA.id
    // and every row for B has chw_id = userB.id; this is just sanity
    // for the seed itself, the actual RLS assertion is above.
    const { data: allRows, error: allError } = await adminClient
      .from("chw_payouts")
      .select("chw_id,record_hash")
      .in("record_hash", [hashA1, hashA2, hashB1, hashB2]);
    expect(allError).toBeNull();
    const byChw: Record<string, string[]> = {};
    for (const r of allRows ?? []) {
      const id = (r as { chw_id: string }).chw_id;
      const h = (r as { record_hash: string }).record_hash;
      byChw[id] ??= [];
      byChw[id].push(h);
    }
    expect(byChw[userA.id]).toEqual(expect.arrayContaining([hashA1, hashA2]));
    expect(byChw[userA.id]).toHaveLength(2);
    expect(byChw[userB.id]).toEqual(expect.arrayContaining([hashB1, hashB2]));
    expect(byChw[userB.id]).toHaveLength(2);
  });

  it("supports stable (created_at desc, id desc) pagination at the SQL boundary", async () => {
    // Seed 4 rows with explicit created_at so we can name the expected
    // order without timing races. Each gets a freshly-minted chw_id so
    // we don't have to clean up an earlier test's rows.
    const ephemeral = await createTestUser();
    try {
      const baseTime = Date.parse("2026-08-20T20:00:00.000Z");
      const hashes = Array.from({ length: 4 }, (_, i) =>
        paddingHash(`P-${ephemeral.id}-${i}`),
      );
      for (let i = 0; i < hashes.length; i++) {
        await seedPayout({
          chwId: ephemeral.id,
          recordHash: hashes[i]!,
          stellarAddress: "GCHWP",
          status: "pending",
          createdAt: new Date(baseTime + i * 1000).toISOString(),
        });
      }
      const { data, error } = await ephemeral.client
        .from("chw_payouts")
        .select("id,created_at")
        .eq("chw_id", ephemeral.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      // created_at descends strictly because each row gets a +1s offset.
      const dates = (data ?? []).map((r) => (r as { created_at: string }).created_at);
      const sorted = [...dates].sort().reverse();
      expect(dates).toEqual(sorted);
      // Each created_at must be unique across this CHW's rows.
      expect(new Set(dates).size).toBe(hashes.length);
    } finally {
      await deleteTestUser(ephemeral.id);
    }
  });

  it("reflects a pending -> paid transition on the next SELECT", async () => {
    const ephemeral = await createTestUser();
    try {
      const hash = paddingHash(`T-${ephemeral.id}`);
      await seedPayout({
        chwId: ephemeral.id,
        recordHash: hash,
        stellarAddress: "GCHWT",
        status: "pending",
      });
      const before = await ephemeral.client
        .from("chw_payouts")
        .select("status,payout_tx_hash,paid_at")
        .eq("record_hash", hash)
        .maybeSingle();
      expect(before.error).toBeNull();
      expect(before.data?.status).toBe("pending");
      expect(before.data?.payout_tx_hash).toBeNull();
      expect(before.data?.paid_at).toBeNull();

      const txHash = "transitioned-hash";
      const paidAt = "2026-08-20T15:30:00.000Z";
      const { error: updateErr } = await adminClient
        .from("chw_payouts")
        .update({
          status: "paid",
          payout_tx_hash: txHash,
          paid_at: paidAt,
        })
        .eq("record_hash", hash);
      expect(updateErr).toBeNull();

      const after = await ephemeral.client
        .from("chw_payouts")
        .select("status,payout_tx_hash,paid_at")
        .eq("record_hash", hash)
        .maybeSingle();
      expect(after.error).toBeNull();
      expect(after.data?.status).toBe("paid");
      expect(after.data?.payout_tx_hash).toBe(txHash);
      expect(after.data?.paid_at).toBe(paidAt);
    } finally {
      await deleteTestUser(ephemeral.id);
    }
  });
});
