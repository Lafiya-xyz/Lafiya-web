import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env-server";
import type { Database } from "@/lib/supabase/types";

/**
 * Closed union of call-site labels for service-role (admin) Supabase usage.
 * Every admin client creation must declare one of these purposes so that
 * privileged access can be audited and reviewed.
 */
export const ADMIN_PURPOSES = [
  "rate-limit",
  "frequency-limit",
  "card-token",
] as const;

export type AdminPurpose = (typeof ADMIN_PURPOSES)[number];

export interface CreateAdminClientOptions {
  /** Call-site label describing why the service-role key is needed. */
  purpose: AdminPurpose;
}

/**
 * Supabase admin client with the service-role key — bypasses RLS and can
 * call `auth.admin.*` endpoints. Never expose this client to the browser or
 * import this file from any module that can be bundled client-side.
 *
 * A `purpose` label is required so that every privileged query can be
 * attributed to a call site. The label is forwarded to Supabase via the
 * `x-client-info` header (visible in API logs) and emitted as a structured
 * audit log entry. No PHI, capability tokens, or secrets are logged.
 */
export function createAdminClient({ purpose }: CreateAdminClientOptions) {
  console.info(
    JSON.stringify({
      event: "supabase.admin_client.created",
      purpose,
    }),
  );

  return createClient<Database>(
    serverEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: {
          "x-client-info": `admin:${purpose}`,
        },
      },
    },
  );
}
