/**
 * Issue #914: offline-first CHW household visit planner.
 *
 * Pure, dependency-free core shared by the planner UI, the encrypted
 * IndexedDB store and the sync route. It owns three things:
 *
 *   1. the minimal patient projection a device may hold (no PHI beyond what
 *      `chw_visit_queue()` already exposes to the matched CHW),
 *   2. conditional-sync reconciliation (ETag / `updated_at` cursor) that
 *      merges server rows with locally completed visits,
 *   3. the deactivation wipe decision, so a suspended/offboarded CHW device
 *      drops its cache on the next successful sync.
 *
 * Nothing here touches the network, IndexedDB or React: the store and the
 * route call into it, which keeps the privacy-critical logic unit-testable.
 */

import {
  canTransitionVisit,
  isClosedVisitStatus,
  type ChwQueueItem,
  type VisitRequestStatus,
} from "./visit-requests";

export const PLANNER_SCHEMA_VERSION = 1;

/** A re-verification task: a record whose attestation is going stale. */
export type PlannerReverificationTask = {
  id: string;
  /** Opaque record reference; never a name, phone or address. */
  record_ref: string;
  lga: string;
  due_at: string;
  status: "due" | "completed" | "dismissed";
};

export type PlannerVisit = ChwQueueItem & {
  /** Server `updated_at`, used as the conditional-sync cursor. */
  updated_at: string;
};

/** What is persisted on the device. Minimal patient data only. */
export type PlannerSnapshot = {
  schema_version: typeof PLANNER_SCHEMA_VERSION;
  chw_id: string;
  synced_at: string;
  visits: PlannerVisit[];
  reverification_tasks: PlannerReverificationTask[];
};

/** A visit completed offline, queued for reconciliation on reconnect. */
export type PlannerCompletion = {
  request_id: string;
  status: Extract<VisitRequestStatus, "verified" | "declined">;
  completed_at: string;
  /** Client-generated idempotency key so replays are harmless. */
  idempotency_key: string;
};

export type PlannerSyncResponse = {
  chw_id: string;
  /** False once the CHW is suspended/offboarded: the device must wipe. */
  active: boolean;
  synced_at: string;
  visits: PlannerVisit[];
  reverification_tasks: PlannerReverificationTask[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPlannerCompletion(value: unknown): value is PlannerCompletion {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.request_id === "string" &&
    UUID_PATTERN.test(c.request_id) &&
    (c.status === "verified" || c.status === "declined") &&
    typeof c.completed_at === "string" &&
    !Number.isNaN(Date.parse(c.completed_at)) &&
    typeof c.idempotency_key === "string" &&
    c.idempotency_key.length >= 8 &&
    c.idempotency_key.length <= 128
  );
}

/**
 * Validates an untrusted sync payload before it is written to the device.
 * Returns null when the payload is malformed or for another CHW.
 */
export function parsePlannerSyncResponse(
  payload: unknown,
  chwId: string,
): PlannerSyncResponse | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.chw_id !== chwId) return null;
  if (typeof p.active !== "boolean") return null;
  if (typeof p.synced_at !== "string" || Number.isNaN(Date.parse(p.synced_at)))
    return null;
  if (!Array.isArray(p.visits) || !Array.isArray(p.reverification_tasks))
    return null;

  const visits: PlannerVisit[] = [];
  for (const raw of p.visits) {
    if (!raw || typeof raw !== "object") return null;
    const v = raw as Record<string, unknown>;
    if (typeof v.id !== "string" || !UUID_PATTERN.test(v.id)) return null;
    if (typeof v.status !== "string") return null;
    if (typeof v.lga !== "string" || typeof v.updated_at !== "string")
      return null;
    visits.push({
      id: v.id,
      status: v.status as VisitRequestStatus,
      lga: v.lga,
      preferred_language:
        typeof v.preferred_language === "string" ? v.preferred_language : null,
      contact_preference: v.contact_preference as ChwQueueItem["contact_preference"],
      contact_phone:
        typeof v.contact_phone === "string" ? v.contact_phone : null,
      updated_at: v.updated_at,
    });
  }

  const tasks: PlannerReverificationTask[] = [];
  for (const raw of p.reverification_tasks) {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (
      typeof t.id !== "string" ||
      typeof t.record_ref !== "string" ||
      typeof t.lga !== "string" ||
      typeof t.due_at !== "string" ||
      (t.status !== "due" && t.status !== "completed" && t.status !== "dismissed")
    ) {
      return null;
    }
    tasks.push({
      id: t.id,
      record_ref: t.record_ref,
      lga: t.lga,
      due_at: t.due_at,
      status: t.status,
    });
  }

  return {
    chw_id: chwId,
    active: p.active,
    synced_at: p.synced_at,
    visits,
    reverification_tasks: tasks,
  };
}

/**
 * Conditional request headers for the next sync. `etag` is the server's
 * opaque validator; `since` is the newest `updated_at` we already hold.
 */
export function plannerSyncHeaders(
  snapshot: PlannerSnapshot | null,
  etag: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-planner-schema": String(PLANNER_SCHEMA_VERSION),
  };
  if (etag) headers["if-none-match"] = etag;
  if (snapshot) {
    const newest = snapshot.visits.reduce(
      (max, v) => (v.updated_at > max ? v.updated_at : max),
      snapshot.synced_at,
    );
    headers["if-modified-since"] = newest;
  }
  return headers;
}

/**
 * Merges a server sync into the local snapshot.
 *
 * - Server rows win for anything the server has moved on (closed visits are
 *   dropped: the planner only lists open work).
 * - Locally completed visits stay visible as completed until the server
 *   acknowledges them, so an offline completion is never lost.
 * - Tasks the server no longer returns are dropped.
 */
export function reconcilePlannerSnapshot(
  previous: PlannerSnapshot | null,
  incoming: PlannerSyncResponse,
  pending: readonly PlannerCompletion[],
): PlannerSnapshot {
  const pendingById = new Map(pending.map((c) => [c.request_id, c]));
  const merged = new Map<string, PlannerVisit>();

  for (const visit of incoming.visits) {
    if (isClosedVisitStatus(visit.status)) continue;
    merged.set(visit.id, visit);
  }

  for (const completion of pending) {
    const existing = merged.get(completion.request_id);
    if (!existing) continue;
    // The server has not caught up yet: show the local outcome.
    if (existing.status === completion.status) continue;
    if (!canTransitionVisit(existing.status, completion.status)) continue;
    merged.set(completion.request_id, {
      ...existing,
      status: completion.status,
      updated_at: completion.completed_at,
    });
  }

  const visits = [...merged.values()].sort((a, b) =>
    a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0,
  );

  return {
    schema_version: PLANNER_SCHEMA_VERSION,
    chw_id: incoming.chw_id,
    synced_at: incoming.synced_at,
    visits,
    reverification_tasks: [...incoming.reverification_tasks].sort((a, b) =>
      a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0,
    ),
  };
}

/** Completions the server has already applied can be dropped from the queue. */
export function acknowledgeCompletions(
  pending: readonly PlannerCompletion[],
  snapshot: PlannerSnapshot,
): PlannerCompletion[] {
  const byId = new Map(snapshot.visits.map((v) => [v.id, v]));
  return pending.filter((c) => {
    const visit = byId.get(c.request_id);
    // Gone from the server (closed/anonymized) or already at our outcome.
    return visit !== undefined && visit.status !== c.status;
  });
}

/**
 * Remote wipe: a device must erase its encrypted store when the CHW is no
 * longer active, or when the sync payload belongs to another CHW.
 */
export function shouldWipePlanner(
  snapshot: PlannerSnapshot | null,
  incoming: PlannerSyncResponse | null,
  chwId: string,
): boolean {
  if (incoming && incoming.chw_id !== chwId) return true;
  if (incoming && !incoming.active) return true;
  if (snapshot && snapshot.chw_id !== chwId) return true;
  return false;
}
