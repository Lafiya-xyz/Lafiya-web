import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env-server";
import type { Database } from "@/lib/supabase/types";

import type { OtpVerifier } from "./merge";

function statelessClient() {
  return createClient<Database>(
    serverEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Email one-time codes through Supabase Auth. Each call uses its own
 * in-memory client so verifying the other account never replaces the
 * requester's session; the session a successful verification creates is
 * signed out immediately.
 */
export const supabaseEmailOtp: OtpVerifier = {
  async send(email) {
    const { error } = await statelessClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) throw new Error("OTP_SEND_FAILED");
  },
  async verify(email, code) {
    if (!/^[0-9]{6,10}$/.test(code)) return false;
    const client = statelessClient();
    const { data, error } = await client.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error || !data.session) return false;
    await client.auth.signOut({ scope: "local" });
    return true;
  },
};
