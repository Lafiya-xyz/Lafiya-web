/**
 * Read-side validators for the CHW payout history API.
 *
 * Spec criterion 4 (roadmap-05): "Amounts and transaction hashes are
 * validated before response serialization."
 *
 * Postgres is the source of truth on shape (numeric(20, 7) with a
 * non-negative check; payout_tx_hash is plain text on its own). But a
 * listener bug or a manual DB repair could leave a row with a malformed
 * tx hash or amount. The validator sits on the server boundary so a
 * single bad row doesn't leak garbage into the client, AND the row is
 * dropped with an operational log entry instead of swallowed silently.
 */

import type { ChwPayoutStatus } from "@/lib/supabase/types";

/**
 * Stellar transaction hashes are 64 uppercase-hex chars. We accept any
 * case to be lenient about historical listeners that wrote lower-case,
 * but reject anything else — including partial or padded values.
 */
const TX_HASH_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export interface SanitizedPayout {
  readonly id: string;
  readonly status: ChwPayoutStatus;
  readonly amount_usdc: string | null;
  readonly attested_at: string;
  readonly paid_at: string | null;
  readonly payout_tx_hash: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Loose type for the post-PostgREST row: supabase-js's typed
 * Database says amount_usdc is `number`, but PostgREST can serialize
 * numeric columns to JSON as strings (when the value would otherwise
 * exceed JS's safe integer range). We accept either and validate that
 * it parses to a non-negative finite number.
 */
export type RawAmount = number | string | null;

export interface SanitizationFailure {
  readonly id: string;
  readonly reasons: ReadonlyArray<string>;
}

export interface SanitizationResult {
  readonly sanitized: SanitizedPayout | null;
  readonly failure: SanitizationFailure | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape-validate a chw_payouts row before it gets serialized to JSON.
 *
 * Returns either:
 *   - `{ sanitized, failure: null }` when the row passes every check,
 *   - `{ sanitized: null, failure }` when the row is unusable.
 *
 * Caller-side guidance: invalid rows are intentionally NOT silently
 * coerced to a partial view. Dropping with a log makes the tick visible
 * to ops and keeps the API surface truthful; a "sanitized-but-suspect"
 * shape would mask a listener bug behind the API.
 */
export function sanitizePayoutForResponse(
  row: {
    readonly id: string;
    readonly status: ChwPayoutStatus;
    readonly amount_usdc: RawAmount;
    readonly attested_at: string;
    readonly paid_at: string | null;
    readonly payout_tx_hash: string | null;
    readonly created_at: string;
    readonly updated_at: string;
  },
): SanitizationResult {
  const reasons: string[] = [];

  if (!UUID_PATTERN.test(row.id)) {
    reasons.push("id");
  }
  if (row.status !== "pending" && row.status !== "paid") {
    reasons.push("status");
  }
  if (typeof row.attested_at !== "string" || row.attested_at.length === 0) {
    reasons.push("attested_at");
  }
  if (row.paid_at !== null && typeof row.paid_at !== "string") {
    reasons.push("paid_at");
  }

  // amount_usdc: must be a finite, non-negative number. The DB column
  // has a non-negative CHECK so a real listener never writes a negative
  // amount, but we still want to refuse NaN/Infinity or non-numeric
  // garbage before serializing.
  //
  // Accepts either a JS number (the type declared in lib/supabase/types)
  // or a numeric string (PostgREST may serialize numeric columns as
  // strings in some configurations to preserve JS's Float64 limit on
  // very large values).
  let amountValue: number;
  let amountValid: boolean;
  if (typeof row.amount_usdc === "number") {
    amountValid =
      Number.isFinite(row.amount_usdc) && row.amount_usdc >= 0;
    amountValue = row.amount_usdc;
  } else if (typeof row.amount_usdc === "string") {
    const parsed = Number(row.amount_usdc);
    amountValid =
      row.amount_usdc.trim() !== "" &&
      Number.isFinite(parsed) &&
      parsed >= 0;
    amountValue = parsed;
  } else {
    amountValid = false;
    amountValue = Number.NaN;
  }
  if (!amountValid) {
    reasons.push("amount_usdc");
  }

  // payout_tx_hash: must be null OR a 64-char hex string.
  if (
    row.payout_tx_hash !== null &&
    (typeof row.payout_tx_hash !== "string" ||
      !TX_HASH_HEX_PATTERN.test(row.payout_tx_hash))
  ) {
    reasons.push("payout_tx_hash");
  }

  // created_at / updated_at must be non-empty strings (the DB types them
  // as timestamptz so this should always hold).
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    reasons.push("created_at");
  }
  if (typeof row.updated_at !== "string" || row.updated_at.length === 0) {
    reasons.push("updated_at");
  }

  if (reasons.length > 0) {
    return {
      sanitized: null,
      failure: { id: row.id ?? "<missing>", reasons },
    };
  }

  return {
    sanitized: {
      id: row.id,
      status: row.status,
      // Decimal precision contract: the DB type is numeric(20, 7) and
      // PostgREST returns it as a JS number (or as a string in some
      // configurations), but the wire format we ship to clients must
      // round-trip exactly. Serializing as a string with .toFixed(7)
      // guarantees the trailing precision is never lost to a Float64
      // round in the client.
      amount_usdc: amountValue.toFixed(7),
      attested_at: row.attested_at,
      paid_at: row.paid_at,
      payout_tx_hash:
        row.payout_tx_hash === null ? null : row.payout_tx_hash.toLowerCase(),
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    failure: null,
  };
}
