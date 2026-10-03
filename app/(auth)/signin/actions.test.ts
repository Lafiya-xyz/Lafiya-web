import { beforeEach, describe, expect, it, vi } from "vitest";
import { signIn } from "./actions";
import { clearAllRateLimits } from "@/lib/rate-limit";
import { redirect } from "next/navigation";
import { SIGN_IN_TIMING_FLOOR_MS } from "@/lib/security/timing";

// Mock functions hoisted before module imports are processed
const { mockSignInWithPassword, mockHeaders, mockWithTimingFloor, mockRpc } =
  vi.hoisted(() => ({
    mockSignInWithPassword: vi.fn(),
    mockHeaders: vi.fn(),
    mockWithTimingFloor: vi.fn(),
    mockRpc: vi.fn(),
  }));

// The real floor is measured by bench/auth-enumeration; here it is recorded
// but not waited on, so the lockout loops below stay fast.
vi.mock("@/lib/security/timing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/timing")>()),
  withTimingFloor: mockWithTimingFloor,
}));

// Mock Supabase Server Client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockImplementation(() => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
    },
    rpc: mockRpc,
  })),
}));

// Mock Next.js Navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Mock Next.js Headers
vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

// lib/rate-limit.ts now persists its state in Postgres (see
// supabase/migrations/20260729120000_rate_limits_table.sql) instead of an
// in-process Map, so it is durable across the concurrent/distributed
// serverless instances this rate limiter actually has to run on. These unit
// tests care about the sign-in action's policy logic, not Postgres itself
// (that atomicity/cross-instance behavior is covered separately by
// tests/integration/rate-limit.test.ts against a real local Supabase), so
// the admin client is faked here with a plain in-memory store that
// implements the same increment/backoff contract as the real
// rate_limit_record_failure() SQL function.
vi.mock("@/lib/supabase/admin", () => {
  const store = new Map<
    string,
    { attempts: number; blocked_until: string | null }
  >();

  function computeBlockedUntil(attempts: number): string | null {
    if (attempts < 5) return null;
    const durationSeconds = Math.min(900, 30 * Math.pow(2, attempts - 5));
    return new Date(Date.now() + durationSeconds * 1000).toISOString();
  }

  return {
    createAdminClient: () => ({
      from: (table: string) => {
        if (table !== "rate_limits") {
          throw new Error(`unexpected table in rate-limit fake: ${table}`);
        }
        return {
          select: () => ({
            eq: (_column: string, key: string) => ({
              maybeSingle: async () => {
                const record = store.get(key);
                return {
                  data: record ? { blocked_until: record.blocked_until } : null,
                  error: null,
                };
              },
            }),
          }),
          delete: () => ({
            eq: async (_column: string, key: string) => {
              store.delete(key);
              return { error: null };
            },
            not: async () => {
              store.clear();
              return { error: null };
            },
          }),
        };
      },
      rpc: async (fn: string, args: { p_key: string }) => {
        if (fn !== "rate_limit_record_failure") {
          throw new Error(`unexpected rpc in rate-limit fake: ${fn}`);
        }
        const record = store.get(args.p_key) ?? {
          attempts: 0,
          blocked_until: null,
        };
        record.attempts += 1;
        record.blocked_until = computeBlockedUntil(record.attempts);
        store.set(args.p_key, record);
        return {
          data: [
            { attempts: record.attempts, blocked_until: record.blocked_until },
          ],
          error: null,
        };
      },
    }),
  };
});

describe("signIn server action rate limiting", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllRateLimits();
    mockWithTimingFloor.mockImplementation(
      (_floor: number, operation: () => Promise<unknown>) => operation(),
    );
    mockRpc.mockResolvedValue({ data: true, error: null });

    // Default headers mock returning client IP header
    mockHeaders.mockResolvedValue({
      get: (name: string) => {
        if (name === "x-forwarded-for") return "192.168.1.1";
        return null;
      },
    });
  });

  it("handles successful sign-in, resets attempts, and redirects", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: {} },
      error: null,
    });

    const formData = new FormData();
    formData.append("email", "patient@lafiya.com");
    formData.append("password", "correct-password");

    const result = await signIn(undefined, formData);

    expect(result).toBeUndefined(); // redirect doesn't return anything
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/profile");
  });

  it("handles failed sign-in by returning incorrect email/password error", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: new Error("Invalid credentials"),
    });

    const formData = new FormData();
    formData.append("email", "patient@lafiya.com");
    formData.append("password", "wrong-password");

    const result = await signIn(undefined, formData);

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("locks out sign-ins after 5 consecutive failed attempts on same email + IP", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: new Error("Invalid credentials"),
    });

    const formData = new FormData();
    formData.append("email", "patient@lafiya.com");
    formData.append("password", "wrong-password");

    // First 4 attempts: allowed but return error
    for (let i = 0; i < 4; i++) {
      const res = await signIn(undefined, formData);
      expect(res).toEqual({ error: "Incorrect email or password." });
    }
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(4);

    // 5th attempt: triggers lockout
    const res5 = await signIn(undefined, formData);
    expect(res5).toEqual({ error: "Incorrect email or password." });
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(5);

    // 6th attempt: blocked immediately before reaching Supabase
    vi.clearAllMocks();
    const res6 = await signIn(undefined, formData);
    expect(res6.error).toContain(
      "Too many failed sign-in attempts. Please try again in 30 seconds.",
    );
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("keys rate limit by email and IP address combination", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: new Error("Invalid credentials"),
    });

    // Lockout patient@lafiya.com from IP 192.168.1.1
    mockHeaders.mockResolvedValue({
      get: (name: string) => {
        if (name === "x-forwarded-for") return "192.168.1.1";
        return null;
      },
    });

    const formData1 = new FormData();
    formData1.append("email", "patient@lafiya.com");
    formData1.append("password", "wrong-password");

    for (let i = 0; i < 5; i++) {
      await signIn(undefined, formData1);
    }

    // Verify it is blocked on next attempt from same IP
    const blockedRes = await signIn(undefined, formData1);
    expect(blockedRes.error).toContain("Too many failed sign-in attempts.");

    // Same email but from a different IP: should still be allowed to try (and fail normally)
    mockHeaders.mockResolvedValue({
      get: (name: string) => {
        if (name === "x-forwarded-for") return "192.168.1.222";
        return null;
      },
    });

    const allowedRes = await signIn(undefined, formData1);
    expect(allowedRes).toEqual({ error: "Incorrect email or password." });

    // Different email from original IP: should still be allowed to try (and fail normally)
    mockHeaders.mockResolvedValue({
      get: (name: string) => {
        if (name === "x-forwarded-for") return "192.168.1.1";
        return null;
      },
    });

    const formData2 = new FormData();
    formData2.append("email", "other@lafiya.com");
    formData2.append("password", "wrong-password");

    const allowedEmailRes = await signIn(undefined, formData2);
    expect(allowedEmailRes).toEqual({ error: "Incorrect email or password." });
  });

  it("trims and lowercases email to prevent casing and trailing whitespace bypasses", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: new Error("Invalid credentials"),
    });

    // Failed attempts with different casings and whitespace
    const emails = [
      "patient@lafiya.com",
      " PATIENT@lafiya.com ",
      "patient@LAFIYA.com",
      "Patient@Lafiya.Com",
      "  patient@lafiya.com  ",
    ];

    for (const email of emails) {
      const formData = new FormData();
      formData.append("email", email);
      formData.append("password", "wrong-password");
      await signIn(undefined, formData);
    }

    // The 6th attempt (even with original casing) should be blocked immediately
    const formData6 = new FormData();
    formData6.append("email", "patient@lafiya.com");
    formData6.append("password", "wrong-password");

    vi.clearAllMocks();
    const res = await signIn(undefined, formData6);
    expect(res.error).toContain("Too many failed sign-in attempts.");
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });
});

describe("signIn account-enumeration resistance (#527)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllRateLimits();
    mockWithTimingFloor.mockImplementation(
      (_floor: number, operation: () => Promise<unknown>) => operation(),
    );
    mockRpc.mockResolvedValue({ data: true, error: null });
    mockHeaders.mockResolvedValue({
      get: (name: string) =>
        name === "x-forwarded-for" ? "203.0.113.7" : null,
    });
  });

  function form(email: string, password = "wrong-password") {
    const formData = new FormData();
    formData.append("email", email);
    formData.append("password", password);
    return formData;
  }

  it("returns an identical body for existing and unknown emails", async () => {
    // Supabase's own errors differ by case; the action must not.
    const supabaseErrors = [
      { code: "invalid_credentials", message: "Invalid login credentials" }, // unknown email or wrong password
      { code: "email_not_confirmed", message: "Email not confirmed" }, // existing, unconfirmed
      { code: "user_banned", message: "User is banned" }, // existing, banned
      {
        code: "over_request_rate_limit",
        message: "Request rate limit reached",
      },
    ];

    const bodies = new Set<string>();
    for (const [index, error] of supabaseErrors.entries()) {
      mockSignInWithPassword.mockResolvedValueOnce({
        data: { user: null, session: null },
        error: Object.assign(new Error(error.message), { code: error.code }),
      });
      bodies.add(
        JSON.stringify(await signIn(undefined, form(`p${index}@lafiya.com`))),
      );
    }

    expect(bodies).toEqual(
      new Set([JSON.stringify({ error: "Incorrect email or password." })]),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it("locks out an unknown email exactly like an existing one", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: new Error("Invalid login credentials"),
    });

    const lockouts: string[] = [];
    for (const email of ["exists@lafiya.com", "nobody@lafiya.com"]) {
      for (let i = 0; i < 5; i++) await signIn(undefined, form(email));
      lockouts.push((await signIn(undefined, form(email))).error ?? "");
    }

    expect(lockouts[0]).toBe(lockouts[1]);
    expect(lockouts[0]).toBe(
      "Too many failed sign-in attempts. Please try again in 30 seconds.",
    );
  });

  it("pads every outcome, including a successful redirect, to the sign-in floor", async () => {
    mockSignInWithPassword.mockResolvedValueOnce({
      data: { user: {} },
      error: null,
    });
    await signIn(undefined, form("exists@lafiya.com", "right-password"));
    mockSignInWithPassword.mockResolvedValueOnce({
      data: null,
      error: new Error("Invalid login credentials"),
    });
    await signIn(undefined, form("nobody@lafiya.com"));

    expect(mockWithTimingFloor).toHaveBeenCalledTimes(2);
    for (const [floor] of mockWithTimingFloor.mock.calls) {
      expect(floor).toBe(SIGN_IN_TIMING_FLOOR_MS);
    }
  });
});

describe("signIn session recording (#523)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllRateLimits();
    mockWithTimingFloor.mockImplementation(
      (_floor: number, operation: () => Promise<unknown>) => operation(),
    );
    mockHeaders.mockResolvedValue({
      get: (name: string) =>
        name === "user-agent"
          ? "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
          : null,
    });
  });

  function form() {
    const formData = new FormData();
    formData.append("email", "patient@lafiya.com");
    formData.append("password", "right-password");
    return formData;
  }

  it("records only the coarse browser and OS family for a new session", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: {} },
      error: null,
    });
    mockRpc.mockResolvedValue({ data: true, error: null });

    await signIn(undefined, form());

    expect(mockRpc).toHaveBeenCalledWith("touch_my_session", {
      p_browser: "Chrome",
      p_os: "Android",
    });
    expect(redirect).toHaveBeenCalledWith("/profile");
  });

  it("still signs in when recording the session fails", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { user: {} },
      error: null,
    });
    mockRpc.mockResolvedValue({ data: null, error: new Error("db down") });

    await signIn(undefined, form());

    expect(redirect).toHaveBeenCalledWith("/profile");
  });

  it("does not record a session for a failed sign-in", async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: null,
      error: new Error("Invalid login credentials"),
    });

    await signIn(undefined, form());

    expect(mockRpc).not.toHaveBeenCalled();
  });
});
