import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  query: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
  or: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { GET } from "./route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const FIRST_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ID = "33333333-3333-4333-8333-333333333333";
const TX_HASH = "a".repeat(64);

function row(id: string, attestedAt: string, overrides = {}) {
  return {
    id,
    attested_at: attestedAt,
    amount_usdc: "12.5000000",
    status: "pending",
    payout_tx_hash: null,
    paid_at: null,
    record_hash: "patient-secret-that-must-not-leak",
    ...overrides,
  };
}

function setupQuery(data: unknown[], error: unknown = null) {
  const builder = {
    select: mocks.query,
    eq: mocks.eq,
    order: mocks.order,
    limit: mocks.limit,
    or: mocks.or,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data, error }).then(resolve),
  };

  mocks.query.mockReturnValue(builder);
  mocks.eq.mockReturnValue(builder);
  mocks.order.mockReturnValue(builder);
  mocks.limit.mockReturnValue(builder);
  mocks.or.mockReturnValue(builder);
  mocks.createClient.mockResolvedValue({
    auth: { getUser: mocks.getUser },
    from: vi.fn(() => builder),
  });
}

function request(query = "") {
  return new Request(`http://localhost/api/chw/payouts${query}`);
}

describe("CHW payout history route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  });

  it("requires an authenticated user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    setupQuery([]);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns an empty page and applies the authenticated CHW filter", async () => {
    setupQuery([]);

    const response = await GET(request("?limit=2"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ payouts: [], nextCursor: null, hasMore: false });
    expect(mocks.eq).toHaveBeenCalledWith("chw_id", USER_ID);
    expect(mocks.order).toHaveBeenNthCalledWith(1, "attested_at", { ascending: false });
    expect(mocks.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(mocks.limit).toHaveBeenCalledWith(3);
  });

  it("returns only the public payout fields and a cursor for another page", async () => {
    setupQuery([
      row(FIRST_ID, "2026-08-19T12:00:00.000Z"),
      row(SECOND_ID, "2026-08-18T12:00:00.000Z", {
        status: "paid",
        amount_usdc: 3.25,
        payout_tx_hash: TX_HASH,
        paid_at: "2026-08-19T13:00:00.000Z",
      }),
    ]);

    const response = await GET(request("?limit=1"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.payouts).toEqual([
      {
        id: FIRST_ID,
        status: "pending",
        amountUsdc: 12.5,
        attestedAt: "2026-08-19T12:00:00.000Z",
        paidAt: null,
        payoutTxHash: null,
        transactionUrl: null,
      },
    ]);
    expect(data.payouts[0]).not.toHaveProperty("record_hash");
    expect(data.nextCursor).toEqual(expect.any(String));
    expect(data.hasMore).toBe(true);
  });

  it("rejects a tampered cursor before querying payout data", async () => {
    setupQuery([]);

    const response = await GET(request("?cursor=not-a-cursor"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid cursor" });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects invalid payout amounts and transaction hashes", async () => {
    setupQuery([
      row(FIRST_ID, "2026-08-19T12:00:00.000Z", {
        amount_usdc: "not-a-number",
        status: "paid",
        payout_tx_hash: "invalid",
      }),
    ]);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Invalid payout data" });
  });
});