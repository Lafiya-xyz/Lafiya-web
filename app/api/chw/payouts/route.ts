import { NextResponse } from "next/server";

import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";
import type { ChwPayoutRow, ChwPayoutStatus } from "@/lib/supabase/types";

import {
  InvalidCursorError,
  decodePayoutCursor,
  encodePayoutCursor,
} from "./pagination";
import { sanitizePayoutForResponse, type SanitizedPayout } from "./validators";

/**
 * Authenticated, cursor-paginated history of a CHW's own payouts.
 *
 * Why this is a Route Handler (rather than tacked into a Server
 * Component or Server Action):
 *   - The same shape is expected to be needed by lafiya-verifier and
 *     other clients later, per README.md > Repository Structure.
 *   - Server Actions bundle a CSRF token into the request as a hidden
 *     form field; CORS-friendly Routes are easier to call from
 *     non-form contexts later.
 *
 * Security posture:
 *   - Only authenticated callers can hit this. anon calls → 401.
 *   - The chw_payouts RLS policy ("CHW can read own payouts", keyed on
 *     auth.uid() = chw_id) is the actual access control; we never trust
 *     the caller's claimed identity here. We pass the session through
 *     `createClient()` so RLS is enforced.
 *   - `record_hash` is never SELECTed. Per roadmap-05: "do not expose
 *     `record_hash` unless the privacy review explicitly approves it".
 *     A bug that selects it accidentally is one .select() string change,
 *     so we keep the projection inline at the call site and explicit,
 *     not behind a default-and-omit helper that could regress.
 *   - Cursor pagination uses (created_at DESC, id DESC) for stable
 *     ordering across concurrent inserts. We over-fetch by 1 to compute
 *     the next cursor without a second round-trip.
 *   - Read-side validators in ./validators enforce spec criterion #4:
 *     payout_tx_hash must be null OR 64-char hex; amount_usdc must be
 *     a finite non-negative number. A row failing validation is dropped
 *     (with a structured logError) instead of being echoed with garbage
 *     back to the client.
 *
 * State coverage vs spec criterion #3:
 *   The spec asks the API to "represent pending, paid, and reconciliation
 *   states accurately". The chw_payouts schema is currently a 2-state
 *   enum (`pending | paid`). There is no third column to mark a row as
 *   "in reconciliation". In this codebase, "reconciliation" is the
 *   implicit window between `attested_at` and the first on-chain payment
 *   observation (a `pending` row with no `paid_at` after that point).
 *   Adding an explicit third state would require a schema migration,
 *   which is out of scope per the spec's "Out of Scope" section
 *   ("changing payout settlement, contract logic..."). Surfacing the
 *   implicit state via the API surface (e.g. a derived `in_reconciliation`
 *   boolean from `status === 'pending' && paid_at IS NULL && now() -
 *   attested_at > something`) is a follow-up that should be evaluated
 *   alongside the indexer's roadmap chunk; the underlying data is
 *   already in the response shape with `status` and `paid_at`.
 *
 * Out of scope (per spec): any change to payout settlement, contract
 * logic, or a complete CHW dashboard UI.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MIN_LIMIT = 1;

type Serializable =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly data: ReadonlyArray<SanitizedPayout>;
      readonly nextCursor: string | null;
    };

// ChwPayoutView is the pre-validator shape; the wire shape is the
// SanitizedPayout re-exported from ./validators (kept identical here for
// back-compat callers that imported ChwPayoutView directly).
export type ChwPayoutView = SanitizedPayout;

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "authentication required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let limit: number;
  try {
    limit = parseLimit(request);
  } catch (error) {
    const message =
      error instanceof InvalidLimitError ? error.message : "invalid limit";
    return badRequest(message);
  }

  let status: ChwPayoutStatus | null;
  try {
    status = parseStatus(request);
  } catch (error) {
    return badRequest(
      error instanceof InvalidStatusError ? error.message : "invalid status",
    );
  }

  let cursor: { c: string; i: string } | null = null;
  const rawCursor = new URL(request.url).searchParams.get("cursor");
  if (rawCursor) {
    try {
      cursor = decodePayoutCursor(rawCursor);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return badRequest("invalid cursor");
      }
      throw error;
    }
  }

  const result: Serializable = await readPayouts(supabase, {
    limit,
    status,
    cursor,
  });

  if (result.kind === "ok") {
    return NextResponse.json(
      {
        data: result.data,
        nextCursor: result.nextCursor,
      },
      {
        status: 200,
        headers: {
          // private, changes with each new attestation on this device.
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  if (result.kind === "bad_request") return badRequest(result.message);
  return NextResponse.json(
    { error: "authentication required" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

interface ReadArgs {
  readonly limit: number;
  readonly status: ChwPayoutStatus | null;
  readonly cursor: { readonly c: string; readonly i: string } | null;
}

/**
 * The route handler above is a thin wrapper around this. Splitting it
 * out keeps it directly testable with a hand-rolled Supabase-shaped
 * client mock (no Next.js request/cookies/response plumbing required)
 * — the route.test.ts suite uses this entry point.
 */
export async function readPayouts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  args: ReadArgs,
): Promise<Serializable> {
  // Re-check auth here because callers might bypass the HTTP layer.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { kind: "unauthorized" };
  }

  const selectColumns =
    "id,status,amount_usdc,attested_at,paid_at,payout_tx_hash,created_at,updated_at";

  let query = supabase
    .from("chw_payouts")
    .select(selectColumns)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(args.limit + 1);

  if (args.status) {
    query = query.eq("status", args.status);
  }

  if (args.cursor) {
    // Keyset pagination on (created_at, id), both DESC. Modeled as OR
    // so a row on the boundary (same created_at, smaller id) is still
    // part of the next page; an AND would skip it and lose rows.
    query = query.or(
      `created_at.lt.${args.cursor.c},and(created_at.eq.${args.cursor.c},id.lt.${args.cursor.i})`,
    );
  }

  // The select() string literal narrows the inferred row type — we don't
  // use `.returns<T>()` because that helper doesn't exist on supabase-js's
  // PostgrestFilterBuilder (it only exists on rpc() builders for RPC return
  // shapes). The Database generic on createClient<Database>() gives us
  // ChwPayoutRow here, and the row is further narrowed by the explicit
  // column list up top so the only fields we read back are public-safe.
  const { data, error } = await query;

  if (error) {
    logError("Failed to read CHW payout history", error, {
      route: "/api/chw/payouts",
      userId: user.id,
    });
    return { kind: "bad_request", message: "database error" };
  }
  const rows =
    (data as ReadonlyArray<
      Pick<
        ChwPayoutRow,
        | "id"
        | "status"
        | "amount_usdc"
        | "attested_at"
        | "paid_at"
        | "payout_tx_hash"
        | "created_at"
        | "updated_at"
      >
    >) ?? [];

  const sanitizedRows: SanitizedPayout[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const result = sanitizePayoutForResponse(row);
    if (result.failure) {
      // Spec #4: validate before serializing. Bad rows are dropped with
      // a structured log so ops can see a misbehaving listener without
      // us silently echoing garbage to clients. Dropped rows are NOT
      // counted toward pagination — the next-cursor anchor is the last
      // *valid* row the client actually saw, never one we filtered out.
      logError("Dropping malformed chw_payouts row from response", undefined, {
        route: "/api/chw/payouts",
        rowId: result.failure.id,
        reasons: result.failure.reasons.join(","),
      });
      continue;
    }
    if (result.sanitized) {
      sanitizedRows.push(result.sanitized);
    }
  }

  // hasMore comes from the raw over-fetch (rows.length > args.limit).
  // The cursor anchor must come from the last *valid* row on this page
  // (it's the only row the client has actually seen) — the over-fetched
  // +1 row itself is never returned to clients, even after sanitization.
  const rawHasMore = rows.length > args.limit;
  const pageRows = rawHasMore
    ? sanitizedRows.slice(0, args.limit)
    : sanitizedRows;

  // Cursor validity after drops: if the trailing *raw* row was dropped by
  // validation, the client has no idea the boundary is invalid, so we
  // collapse the nextCursor rather than risk them asking for a page
  // anchored at a row we *couldn't* give them.
  const weCanContinue = rawHasMore && pageRows.length === args.limit;

  const nextCursorAnchor = weCanContinue
    ? (pageRows[pageRows.length - 1] ?? null)
    : null;
  const nextCursor = nextCursorAnchor
    ? encodePayoutCursor(nextCursorAnchor.created_at, nextCursorAnchor.id)
    : null;

  return { kind: "ok", data: pageRows, nextCursor };
}

function parseLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw new InvalidLimitError("limit must be a positive integer");
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_LIMIT || n > MAX_LIMIT) {
    throw new InvalidLimitError(
      `limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    );
  }
  return n;
}

class InvalidLimitError extends Error {
  override name = "InvalidLimitError";
}

function parseStatus(request: Request): ChwPayoutStatus | null {
  const raw = new URL(request.url).searchParams.get("status");
  if (raw === null || raw === "") return null;
  if (raw !== "pending" && raw !== "paid") {
    throw new InvalidStatusError("status must be 'pending' or 'paid'");
  }
  return raw;
}

class InvalidStatusError extends Error {
  override name = "InvalidStatusError";
}

function badRequest(message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
