import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env-server";
import type { Database } from "@/lib/supabase/types";

/**
 * Supabase admin client with the service-role key — bypasses RLS and can
 * call `auth.admin.*` endpoints. Never expose this client to the browser or
 * import this file from any module that can be bundled client-side.
 */
export function createAdminClient() {
  return createClient<Database>(
    serverEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
