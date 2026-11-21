import { NextResponse } from "next/server";

import {
  PLANNER_SCHEMA_VERSION,
  parsePlannerSyncResponse,
  type PlannerReverificationTask,
  type PlannerSyncResponse,
  type PlannerVisit,
} from "@/lib/chw-protocol/visit-planner";
import type { VisitRequestStatus } from "@/lib/chw-protocol/visit-requests";
import { createClient } from "@/lib/supabase/server";

const ACTIVE_CHW_STATUS = "active";

type QueueRow = {
  id: string;
  status: string;
  lga: string;
  preferred_language: string | null;
  contact_preference: string;
  contact_phone: string | null;
};

type TaskRow = {
  id: string;
  record_ref: string;
  lga: string;
  due_at: string;
  status: string;
};

/**
 * Issue #914: conditional sync for the offline CHW visit planner.
 *
 * Returns the minimal projection the device may cache (the same fields
 * `chw_visit_queue()` already exposes to the matched CHW) plus re-verification
 * tasks. `active: false` tells the device to wipe its encrypted store.
 *
 * Conditional requests: `If-None-Match` is answered with 304 when the caller's
 * validator still matches, so an offline-first client can poll cheaply.
 */
export async function GET(request: Request) {
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

  const active = identity?.status === ACTIVE_CHW_STATUS;

  if (!active) {
    // Deactivated (or never enrolled): the device must erase its cache.
    const body: PlannerSyncResponse = {
      chw_id: user.id,
      active: false,
      synced_at: new Date().toISOString(),
      visits: [],
      reverification_tasks: [],
    };
    return NextResponse.json(body, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  const { data: queue, error: queueError } = await supabase.rpc(
    "chw_visit_queue",
  );
  if (queueError) {
    return NextResponse.json(
      { error: "Unable to load visit planner" },
      { status: 500 },
    );
  }

  const { data: tasks, error: tasksError } = await supabase
    .from("chw_reverification_tasks")
    .select("id, record_ref, lga, due_at, status")
    .eq("chw_id", user.id)
    .order("due_at", { ascending: true })
    .limit(200);
  if (tasksError) {
    return NextResponse.json(
      { error: "Unable to load visit planner" },
      { status: 500 },
    );
  }

  const syncedAt = new Date().toISOString();
  const visits: PlannerVisit[] = ((queue ?? []) as QueueRow[]).map((row) => ({
    id: row.id,
    status: row.status as VisitRequestStatus,
    lga: row.lga,
    preferred_language: row.preferred_language,
    contact_preference: row.contact_preference as PlannerVisit["contact_preference"],
    contact_phone: row.contact_phone,
    updated_at: syncedAt,
  }));

  const reverificationTasks: PlannerReverificationTask[] = (
    (tasks ?? []) as TaskRow[]
  ).map((row) => ({
    id: row.id,
    record_ref: row.record_ref,
    lga: row.lga,
    due_at: row.due_at,
    status: row.status as PlannerReverificationTask["status"],
  }));

  const body: PlannerSyncResponse = {
    chw_id: user.id,
    active: true,
    synced_at: syncedAt,
    visits,
    reverification_tasks: reverificationTasks,
  };

  // Re-validate our own payload before it leaves the server: a malformed row
  // must never reach a device cache.
  if (!parsePlannerSyncResponse(body, user.id)) {
    return NextResponse.json(
      { error: "Unable to load visit planner" },
      { status: 500 },
    );
  }

  const etag = `"${PLANNER_SCHEMA_VERSION}-${syncedAt}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { etag, "cache-control": "private, no-store" },
    });
  }

  return NextResponse.json(body, {
    headers: { etag, "cache-control": "private, no-store" },
  });
}
