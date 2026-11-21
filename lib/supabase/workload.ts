import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env-server";
import type { Database } from "@/lib/supabase/types";

/**
 * Closed union of least-privilege Postgres roles (issue #887). Each workload
 * connects with its own credentials instead of the service role; the role is
 * granted only the tables/functions that workload needs (see
 * `supabase/migrations/*_workload_roles.sql`).
 */
export const WORKLOAD_ROLES = [
  "payout_indexer",
  "verification_indexer",
  "outbox_dispatcher",
] as const;

export type WorkloadRole = (typeof WORKLOAD_ROLES)[number];

/**
 * Environment variable holding the JWT for each workload role. The JWT carries
 * `role: <workload>` so PostgREST switches to that Postgres role.
 */
export const WORKLOAD_KEY_ENV: Record<WorkloadRole, string> = {
  payout_indexer: "SUPABASE_PAYOUT_INDEXER_KEY",
  verification_indexer: "SUPABASE_VERIFICATION_INDEXER_KEY",
  outbox_dispatcher: "SUPABASE_OUTBOX_DISPATCHER_KEY",
};

/**
 * Supabase client authenticated as a dedicated workload role. Never bypasses
 * RLS: the role has no `BYPASSRLS` and only the grants its workload needs.
 *
 * Fails closed — a workload without its own key must not silently fall back to
 * the service role.
 */
export function createWorkloadClient(role: WorkloadRole) {
  const envName = WORKLOAD_KEY_ENV[role];
  const key = process.env[envName];
  if (!key) {
    throw new Error(
      `missing ${envName}: workload "${role}" must connect with its own least-privilege credentials (issue #887)`,
    );
  }

  return createClient<Database>(serverEnv.NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-client-info": `workload:${role}` } },
  });
}
