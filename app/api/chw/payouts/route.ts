import { NextResponse } from "next/server";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import type { ChwPayoutStatus } from "@/lib/supabase/types";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const TRANSACTION_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cursorSchema = z.object({
  attestedAt: z.string().datetime({ offset: true }),
  id: z.string().regex(UUID_PATTERN),
});

const payoutRowSchema = z.object({
  id: z.string().regex(UUID_PATTERN),
  attested_at: z.string().datetime({ offset: true }),
  amount_usdc: z.union([z.number(), z.string()]),
  status: z.enum(["pending", "paid"]),
  payout_tx_hash: z.string().nullable(),
  paid_at: z.string().datetime({ offset: true }).nullable(),
});

type PayoutRow = z.infer<typeof payoutRowSchema>;

function decodeCursor(value: string | null) {
  if (!value) return null;

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return cursorSchema.parse(JSON.parse(decoded));
  } catch {
    return undefined;
  }
}

function encodeCursor(row: PayoutRow) {
  return Buffer.from(
    JSON.stringify({ attestedAt: row.attested_at, id: row.id }),
  ).toString("base64url");
}

function transactionUrl(transactionHash: string) {
  const network =
    process.env.STELLAR_NETWORK_PASSPHRASE?.includes("Test")
      ? "testnet"
      : "public";
  return `https://stellar.expert/explorer/${network}/tx/${transactionHash}`;
}

function serializePayout(row: unknown) {
  const parsed = payoutRowSchema.safeParse(row);
  if (!parsed.success) return null;

  const amount = Number(parsed.data.amount_usdc);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const payoutTxHash = parsed.data.payout_tx_hash;
  if (payoutTxHash !== null && !TRANSACTION_HASH_PATTERN.test(payoutTxHash)) {
    return null;
  }
  if (parsed.data.status === "paid" && payoutTxHash === null) return null;

  return {
    id: parsed.data.id,
    status: parsed.data.status satisfies ChwPayoutStatus,
    amountUsdc: amount,
    attestedAt: parsed.data.attested_at,
    paidAt: parsed.data.paid_at,
    payoutTxHash,
    transactionUrl: payoutTxHash ? transactionUrl(payoutTxHash) : null,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const cursor = decodeCursor(searchParams.get("cursor"));

  if (cursor === undefined) {
    return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let query = supabase
      .from("chw_payouts")
      .select("id,attested_at,amount_usdc,status,payout_tx_hash,paid_at")
      .eq("chw_id", user.id)
      .order("attested_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);

    if (cursor) {
      query = query.or(
        `attested_at.lt.${cursor.attestedAt},and(attested_at.eq.${cursor.attestedAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: "Unable to load payout history" }, { status: 500 });
    }

    const rows = (data ?? []).map(serializePayout);
    if (rows.some((row) => row === null)) {
      return NextResponse.json({ error: "Invalid payout data" }, { status: 500 });
    }

    const hasMore = rows.length > limit;
    const payouts = rows.slice(0, limit);
    const lastRow = data?.[limit - 1];

    return NextResponse.json({
      payouts,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
      hasMore,
    });
  } catch {
    return NextResponse.json({ error: "Unable to load payout history" }, { status: 500 });
  }
}