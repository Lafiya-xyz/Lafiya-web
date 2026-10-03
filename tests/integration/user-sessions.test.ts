import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { proxy } from "@/proxy";
import { sessionIdFromAccessToken } from "@/lib/sessions/throttle";
import type { Database } from "@/lib/supabase/types";

import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const PASSWORD = "test-password-123456";

interface Device {
  client: SupabaseClient<Database>;
  jar: Map<string, string>;
  sessionId: string;
}

/**
 * Signs in through @supabase/ssr with an in-memory cookie jar, which is
 * exactly how the browser's cookies reach proxy.ts, so each call is an
 * independent "device" with its own auth session.
 */
async function signInDevice(email: string): Promise<Device> {
  const jar = new Map<string, string>();
  const client = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error) throw error;
  const {
    data: { session },
  } = await client.auth.getSession();
  const sessionId = sessionIdFromAccessToken(session?.access_token);
  if (!sessionId) throw new Error("sign-in produced no session_id claim");
  return { client, jar, sessionId };
}

function profileRequest(device: Device): NextRequest {
  return new NextRequest("http://localhost:3000/profile", {
    headers: {
      cookie: [...device.jar]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      "user-agent":
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    },
  });
}

function isRedirectToSignIn(response: Response): boolean {
  const location = response.headers.get("location");
  return (
    response.status >= 300 &&
    response.status < 400 &&
    location !== null &&
    new URL(location).pathname === "/signin"
  );
}

describe("active-session management (#523)", () => {
  let owner: TestUser;
  let stranger: TestUser;

  beforeAll(async () => {
    owner = await createTestUser();
    stranger = await createTestUser();
  });

  afterAll(async () => {
    await deleteTestUser(owner.id);
    await deleteTestUser(stranger.id);
  });

  it("records sessions with coarse metadata only, and throttles last-seen writes", async () => {
    const phone = await signInDevice(owner.email);

    const first = await phone.client.rpc("touch_my_session", {
      p_browser: "Chrome",
      p_os: "Android",
    });
    const second = await phone.client.rpc("touch_my_session", {
      p_browser: "Chrome",
      p_os: "Android",
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);
    // Within five minutes: no write, whichever app instance calls.
    expect(second.data).toBe(false);

    const { data: rows } = await phone.client
      .from("user_sessions")
      .select("*")
      .eq("session_id", phone.sessionId);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows![0]).sort()).toEqual([
      "browser",
      "created_at",
      "last_seen_at",
      "os",
      "session_id",
      "user_id",
    ]);
    expect(rows![0]).toMatchObject({ browser: "Chrome", os: "Android" });
  });

  it("stores unknown browser/OS values as 'Other' rather than free text", async () => {
    const device = await signInDevice(owner.email);
    await device.client.rpc("touch_my_session", {
      // Deliberately outside the vocabulary, as a hostile client might send.
      p_browser: "Chrome 126.0.6478.127 (Pixel 8, Lagos)" as "Chrome",
      p_os: "Android 14 build UP1A" as "Android",
    });
    const { data } = await device.client
      .from("user_sessions")
      .select("browser, os")
      .eq("session_id", device.sessionId)
      .single();
    expect(data).toEqual({ browser: "Other", os: "Other" });
  });

  it("revoking one of two sessions sends the revoked device to sign-in on its next request", async () => {
    const laptop = await signInDevice(owner.email);
    const lostPhone = await signInDevice(owner.email);

    // Both devices pass the proxy before revocation.
    expect(isRedirectToSignIn(await proxy(profileRequest(laptop)))).toBe(false);
    expect(isRedirectToSignIn(await proxy(profileRequest(lostPhone)))).toBe(
      false,
    );

    const { data: revoked, error } = await laptop.client.rpc(
      "revoke_my_session",
      { p_session_id: lostPhone.sessionId },
    );
    expect(error).toBeNull();
    expect(revoked).toBe(true);

    // The very next request from the revoked device is redirected.
    expect(isRedirectToSignIn(await proxy(profileRequest(lostPhone)))).toBe(
      true,
    );
    // Its refresh token no longer works either.
    const { error: refreshError } =
      await lostPhone.client.auth.refreshSession();
    expect(refreshError).not.toBeNull();
    // The device that revoked it is unaffected.
    expect(isRedirectToSignIn(await proxy(profileRequest(laptop)))).toBe(false);

    const { data: remaining } = await laptop.client
      .from("user_sessions")
      .select("session_id")
      .eq("session_id", lostPhone.sessionId);
    expect(remaining).toEqual([]);
  });

  it("sign out everywhere else keeps only the current session", async () => {
    const current = await signInDevice(owner.email);
    const other = await signInDevice(owner.email);

    const { error } = await current.client.auth.signOut({ scope: "others" });
    expect(error).toBeNull();

    expect(isRedirectToSignIn(await proxy(profileRequest(other)))).toBe(true);
    expect(isRedirectToSignIn(await proxy(profileRequest(current)))).toBe(
      false,
    );
  });

  it("never lets one user see or revoke another user's sessions", async () => {
    const victim = await signInDevice(owner.email);
    await victim.client.rpc("touch_my_session", {
      p_browser: "Safari",
      p_os: "iOS",
    });
    const attacker = await signInDevice(stranger.email);

    const { data: visible } = await attacker.client
      .from("user_sessions")
      .select("session_id")
      .eq("user_id", owner.id);
    expect(visible).toEqual([]);

    const { data: revoked } = await attacker.client.rpc("revoke_my_session", {
      p_session_id: victim.sessionId,
    });
    expect(revoked).toBe(false);
    expect(isRedirectToSignIn(await proxy(profileRequest(victim)))).toBe(false);
  });

  it("purges rows when their session ends", async () => {
    const device = await signInDevice(owner.email);
    await device.client.rpc("touch_my_session", {
      p_browser: "Firefox",
      p_os: "Linux",
    });

    await device.client.auth.signOut({ scope: "local" });

    const { data } = await adminClient
      .from("user_sessions")
      .select("session_id")
      .eq("session_id", device.sessionId);
    expect(data).toEqual([]);

    const { error } = await adminClient.rpc("purge_expired_user_sessions");
    expect(error).toBeNull();
  });
});
