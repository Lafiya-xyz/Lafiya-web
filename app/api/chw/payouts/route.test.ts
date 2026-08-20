import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/logging/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  decodePayoutCursor,
  encodePayoutCursor,
  InvalidCursorError,
} from "./pagination";
import { GET, readPayouts } from "./route";
import { sanitizePayoutForResponse } from "./validators";
import { createClient } from "@/lib/supabase/server";

const mockedCreateClient = vi.mocked(createClient);

/**
 * Builds a hand-rolled query builder that supports every supabase-js
 * PostgrestFilterBuilder method this route actually chains together
 * (select/order/eq/limit/or) and resolves to `result` when awaited.
 * Each method records its call for later assertion.
 *
 * The "then" trick is exactly how vitest-mocked chain builders across
 * this repo work today (see app/(auth)/profile/actions.test.ts); copying
 * that shape keeps the route's own mocks free of any hidden contract.
 */
function buildQueryChain(result: { data: unknown[]; error: unknown }): {
  select: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  resolve: () => Promise<{ data: unknown[]; error: unknown }>;
} & { awaiter: Promise<{ data: unknown[]; error: unknown }> } {
  const calls: { method: string; args: unknown[] }[] = [];

  const chain: Record<string, unknown> = {};
  const makeChain = () => chain;
  Object.defineProperty(chain, "select", {
    value: vi.fn((...args: unknown[]) => {
      calls.push({ method: "select", args });
      return makeChain();
    }),
  });
  Object.defineProperty(chain, "order", {
    value: vi.fn((...args: unknown[]) => {
      calls.push({ method: "order", args });
      return makeChain();
    }),
  });
  Object.defineProperty(chain, "eq", {
    value: vi.fn((...args: unknown[]) => {
      calls.push({ method: "eq", args });
      return makeChain();
    }),
  });
  Object.defineProperty(chain, "or", {
    value: vi.fn((...args: unknown[]) => {
      calls.push({ method: "or", args });
      return makeChain();
    }),
  });
  Object.defineProperty(chain, "limit", {
    value: vi.fn((...args: unknown[]) => {
      calls.push({ method: "limit", args });
      return makeChain();
    }),
  });
  Object.defineProperty(chain, "then", {
    get() {
      return (resolve: (v: { data: unknown[]; error: unknown }) => void) =>
        resolve(result);
    },
  });

  return chain as never;
}

function mockSupabase(
  user: { id: string } | null,
  rows: unknown[],
  error: unknown = null,
): { from: ReturnType<typeof vi.fn> } {
  const chain = buildQueryChain({ data: rows, error });
  const fromSpy = vi.fn().mockReturnValue(chain);
  mockedCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user },
        error: user ? null : new Error("not authenticated"),
      }),
    },
    from: fromSpy,
  } as never);
  return { from: fromSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Sample row used across tests with a real-shape chw_payouts row.
const baseRow = {
  record_hash: "0".repeat(64),
  stellar_address: "GABC",
  chw_id: "user-1",
  id: "11111111-1111-1111-1111-111111111111",
  status: "paid",
  amount_usdc: "2.5000000",
  attested_at: "2026-08-20T10:00:00.000Z",
  paid_at: "2026-08-20T10:01:00.000Z",
  payout_tx_hash: "f".repeat(64),
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T10:01:00.000Z",
};

describe("GET /api/chw/payouts", () => {
  const user = { id: "user-1" };

  it("returns 401 when there is no authenticated session", async () => {
    mockSupabase(null, []);
    const response = await GET(new Request("http://localhost/api/chw/payouts"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "authentication required",
    });
  });

  it("returns the caller's own rows without any record_hash or chw_id", async () => {
    mockSupabase(user, [baseRow]);
    const response = await GET(new Request("http://localhost/api/chw/payouts"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(body.data).toHaveLength(1);
    const [row] = body.data;
    expect(row).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      status: "paid",
      amount_usdc: "2.5000000",
      attested_at: baseRow.attested_at,
      paid_at: baseRow.paid_at,
      payout_tx_hash: baseRow.payout_tx_hash,
      created_at: baseRow.created_at,
      updated_at: baseRow.updated_at,
    });
    expect(row).not.toHaveProperty("record_hash");
    expect(row).not.toHaveProperty("chw_id");
    expect(row).not.toHaveProperty("stellar_address");
    expect(body.nextCursor).toBeNull();
  });

  it("selects only public-safe columns", async () => {
    const { from } = mockSupabase(user, [baseRow]);
    const response = await GET(new Request("http://localhost/api/chw/payouts"));
    expect(response.status).toBe(200);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("chw_payouts");
    const chain = from.mock.results[0]!.value as {
      select: ReturnType<typeof vi.fn>;
    };
    const [selectArg] = chain.select.mock.calls[0] as [string];
    expect(selectArg).not.toMatch(/record_hash/);
    expect(selectArg).not.toMatch(/chw_id/);
    expect(selectArg).not.toMatch(/stellar_address/);
    expect(selectArg).toMatch(/id/);
    expect(selectArg).toMatch(/status/);
    expect(selectArg).toMatch(/amount_usdc/);
    expect(selectArg).toMatch(/payout_tx_hash/);
    expect(selectArg).toMatch(/paid_at/);
  });

  it("returns an empty page when there are no rows", async () => {
    mockSupabase(user, []);
    const response = await GET(new Request("http://localhost/api/chw/payouts"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], nextCursor: null });
  });

  it("emits a nextCursor when more rows are available than the limit", async () => {
    const lastId = "00000000-0000-0000-0000-000000000024";
    const rows = Array.from({ length: 26 }, (_, i) => ({
      ...baseRow,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      created_at: `2026-08-20T10:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    void lastId;
    mockSupabase(user, rows);
    const response = await GET(
      new Request("http://localhost/api/chw/payouts?limit=25"),
    );
    const body = (await response.json()) as {
      data: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(body.data).toHaveLength(25);
    expect(body.nextCursor).not.toBeNull();
    const decoded = decodePayoutCursor(body.nextCursor as string);
    expect(decoded).toEqual({
      c: "2026-08-20T10:00:24.000Z",
      i: "00000000-0000-0000-0000-000000000024",
    });
  });

  it("returns 400 for an invalid status", async () => {
    mockSupabase(user, []);
    const response = await GET(
      new Request("http://localhost/api/chw/payouts?status=bogus"),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for a tampered cursor", async () => {
    mockSupabase(user, []);
    const response = await GET(
      new Request("http://localhost/api/chw/payouts?cursor=not-a-cursor"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid cursor" });
  });

  it("returns 400 for a limit outside the allowed range", async () => {
    mockSupabase(user, []);
    const response = await GET(
      new Request("http://localhost/api/chw/payouts?limit=100000"),
    );
    expect(response.status).toBe(400);
  });

  it("emits a Cache-Control: private, no-store header on success", async () => {
    mockSupabase(user, [baseRow]);
    const response = await GET(new Request("http://localhost/api/chw/payouts"));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("readPayouts", () => {
  it("returns unauthorized when there is no authenticated session", async () => {
    const chain = buildQueryChain({ data: [], error: null });
    const result = await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: null },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: null, cursor: null },
    );
    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("returns an empty resultset without a nextCursor when no rows", async () => {
    const chain = buildQueryChain({ data: [], error: null });
    const result = await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u" } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: null, cursor: null },
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("over-fetches by 1 to compute nextCursor from the extra row", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      status: "paid" as const,
      amount_usdc: "1.0000000",
      attested_at: "2026-08-20T10:00:00.000Z",
      paid_at: "2026-08-20T10:01:00.000Z",
      payout_tx_hash: String(i).padStart(64, "0"),
      created_at: `2026-08-20T10:00:${String(i).padStart(2, "0")}.000Z`,
      updated_at: "2026-08-20T10:01:00.000Z",
    }));
    const chain = buildQueryChain({ data: rows, error: null });
    const limitCalls = (chain as unknown as { limit: ReturnType<typeof vi.fn> })
      .limit.mock.calls;
    const result = await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u" } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: null, cursor: null },
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data).toHaveLength(10);
    expect(result.nextCursor).not.toBeNull();
    expect(limitCalls[0]?.[0]).toBe(11);
    const decoded = result.nextCursor
      ? decodePayoutCursor(result.nextCursor)
      : null;
    expect(decoded).toEqual({
      c: "2026-08-20T10:00:09.000Z",
      i: "00000000-0000-0000-0000-000000000009",
    });
  });

  it("uses (created_at desc, id desc) ordering", async () => {
    const chain = buildQueryChain({ data: [], error: null });
    const orderCalls = (chain as unknown as { order: ReturnType<typeof vi.fn> })
      .order.mock.calls;
    await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u" } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: null, cursor: null },
    );
    expect(orderCalls).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("emits a keyset OR predicate when a cursor is supplied", async () => {
    const cursor = encodePayoutCursor(
      "2026-08-20T10:00:24.000Z",
      "00000000-0000-0000-0000-000000000024",
    );
    const chain = buildQueryChain({ data: [], error: null });
    const orCalls = (chain as unknown as { or: ReturnType<typeof vi.fn> }).or
      .mock.calls;
    const eqCalls = (chain as unknown as { eq: ReturnType<typeof vi.fn> }).eq
      .mock.calls;
    await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u" } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: null, cursor: decodePayoutCursor(cursor) },
    );
    expect(orCalls).toHaveLength(1);
    const [orExpr] = orCalls[0] as [string];
    expect(orExpr).toMatch(/created_at\.lt\.2026-08-20T10:00:24\.000Z/);
    expect(orExpr).toMatch(/created_at\.eq\.2026-08-20T10:00:24\.000Z/);
    expect(orExpr).toMatch(/id\.lt\.00000000-0000-0000-0000-000000000024/);
    expect(eqCalls.filter((c) => c[0] === "status")).toHaveLength(0);
  });

  it("applies a status eq predicate when status is supplied", async () => {
    const chain = buildQueryChain({ data: [], error: null });
    const eqCalls = (chain as unknown as { eq: ReturnType<typeof vi.fn> }).eq
      .mock.calls;
    await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u" } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: "paid", cursor: null },
    );
    expect(eqCalls.filter((c) => c[0] === "status")).toEqual([
      ["status", "paid"],
    ]);
  });

  it("returns bad_request when the database query errors", async () => {
    const chain = buildQueryChain({
      data: [],
      error: Object.assign(new Error("db down"), { message: "db down" }),
    });
    const result = await readPayouts(
      {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u" } },
            error: null,
          }),
        },
        from: vi.fn().mockReturnValue(chain),
      } as never,
      { limit: 10, status: null, cursor: null },
    );
    expect(result.kind).toBe("bad_request");
  });
});

describe("cursor codec", () => {
  it("round-trips an encoded cursor", () => {
    const id = crypto.randomUUID();
    const encoded = encodePayoutCursor("2026-08-20T10:00:24.000Z", id);
    const decoded = decodePayoutCursor(encoded);
    expect(decoded).toEqual({ c: "2026-08-20T10:00:24.000Z", i: id });
  });

  it("rejects empty cursors", () => {
    expect(() => decodePayoutCursor("")).toThrow(InvalidCursorError);
  });

  it("rejects cursors that fail base64url decoding", () => {
    expect(() => decodePayoutCursor("$$$")).toThrow(InvalidCursorError);
  });

  it("rejects cursors whose decoded JSON has the wrong shape", () => {
    const wrongShape = Buffer.from(JSON.stringify({ x: 1 }), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePayoutCursor(wrongShape)).toThrow(InvalidCursorError);
  });

  it("rejects cursors whose decoded id is not a UUID", () => {
    const wrongId = Buffer.from(
      JSON.stringify({
        c: "2026-08-20T10:00:24.000Z",
        i: "not-a-uuid",
      }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePayoutCursor(wrongId)).toThrow(InvalidCursorError);
  });

  it("rejects cursors whose decoded timestamp is not ISO", () => {
    const wrongTs = Buffer.from(
      JSON.stringify({ c: "yesterday", i: crypto.randomUUID() }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodePayoutCursor(wrongTs)).toThrow(InvalidCursorError);
  });

  it("encode fails loudly on non-UUID id so we don't ship bad cursors", () => {
    expect(() => encodePayoutCursor("2026-08-20T10:00:24.000Z", "u")).toThrow(
      InvalidCursorError,
    );
  });

  it("encode rejects non-ISO timestamps", () => {
    expect(() => encodePayoutCursor("not-an-iso", crypto.randomUUID())).toThrow(
      InvalidCursorError,
    );
  });

  it("rejects oversized cursors before performing base64 work", () => {
    const huge = "A".repeat(513);
    expect(() => decodePayoutCursor(huge)).toThrow(InvalidCursorError);
  });
});

describe("sanitizePayoutForResponse (spec criterion #4)", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const validRow = {
    id,
    status: "paid" as const,
    amount_usdc: 2.5,
    attested_at: "2026-08-20T10:00:00.000Z",
    paid_at: "2026-08-20T10:01:00.000Z",
    payout_tx_hash: "0123456789abcdef".repeat(4),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T10:01:00.000Z",
  };

  it("passes a well-formed row through unchanged with serialized decimals", () => {
    const result = sanitizePayoutForResponse(validRow);
    expect(result.failure).toBeNull();
    expect(result.sanitized).not.toBeNull();
    expect(result.sanitized?.amount_usdc).toBe("2.5000000");
    expect(result.sanitized?.payout_tx_hash).toBe("0123456789abcdef".repeat(4));
  });

  it("normalizes payout_tx_hash to lower-case", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      payout_tx_hash: "ABCDEF" + "0".repeat(58),
    });
    expect(result.failure).toBeNull();
    expect(result.sanitized?.payout_tx_hash).toBe("abcdef" + "0".repeat(58));
  });

  it("accepts a null payout_tx_hash (pending row)", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      status: "pending",
      paid_at: null,
      payout_tx_hash: null,
    });
    expect(result.failure).toBeNull();
    expect(result.sanitized?.payout_tx_hash).toBeNull();
    expect(result.sanitized?.status).toBe("pending");
  });

  it("rejects a row whose payout_tx_hash is not 64-char hex", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      payout_tx_hash: "totally-not-a-hex-tx",
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("payout_tx_hash");
  });

  it("rejects an oversized payout_tx_hash", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      payout_tx_hash: "a".repeat(65),
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("payout_tx_hash");
  });

  it("rejects a negative amount_usdc", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      amount_usdc: -1,
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("amount_usdc");
  });

  it("rejects a NaN amount_usdc", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      amount_usdc: Number.NaN,
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("amount_usdc");
  });

  it("rejects a status that is not pending|paid", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      // Bypassing the `ChwPayoutStatus` type intentionally to hit the
      // validator's runtime branch.
      status: "lol-not-a-state" as unknown as "paid",
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("status");
  });

  it("rejects a non-UUID id and reports it as the offending field", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      id: "not-a-uuid" as unknown as typeof validRow.id,
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("id");
  });

  it("rejects an empty attested_at", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      attested_at: "",
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("attested_at");
  });

  it("rejects non-string paid_at when set", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      paid_at: 123 as unknown as string | null,
    });
    expect(result.sanitized).toBeNull();
    expect(result.failure?.reasons).toContain("paid_at");
  });

  it("serializes amount with 7 trailing decimals even on whole numbers", () => {
    const result = sanitizePayoutForResponse({
      ...validRow,
      amount_usdc: 3,
    });
    expect(result.sanitized?.amount_usdc).toBe("3.0000000");
  });
});
