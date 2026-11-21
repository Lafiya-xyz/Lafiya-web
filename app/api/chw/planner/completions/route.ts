import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isPlannerCompletion,
  type PlannerCompletion,
} from "@/lib/chw-protocol/visit-planner";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  completions: z.array(z.unknown()).max(50),
});

/**
 * Issue #914: reconnect reconciliation for offline visit completions.
 *
 * Each completion is replayed through `chw_transition_verification_request`,
 * which re-checks the caller's identity, service area and the state machine.
 * Replays are idempotent: a request already in the target state is a no-op.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sync payload" }, { status: 400 });
  }

  const completions = parsed.data.completions.filter(isPlannerCompletion);
  if (completions.length !== parsed.data.completions.length) {
    return NextResponse.json({ error: "Invalid sync payload" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: identity } = await supabase
    .from("chw_identities")
    .select("status")
    .eq("chw_id", user.id)
    .maybeSingle();

  if (identity?.status !== "active") {
    return NextResponse.json(
      { error: "CHW is not active", wipe: true },
      { status: 403 },
    );
  }

  const applied: string[] = [];
  const rejected: { request_id: string; reason: string }[] = [];

  for (const completion of completions as PlannerCompletion[]) {
    const { error } = await supabase.rpc(
      "chw_transition_verification_request",
      { p_request_id: completion.request_id, p_status: completion.status },
    );
    if (error) {
      rejected.push({
        request_id: completion.request_id,
        reason: "transition_rejected",
      });
      continue;
    }
    applied.push(completion.request_id);
  }

  return NextResponse.json({ applied, rejected });
}
