import { beforeEach, describe, it, expect, vi } from "vitest";
import { redirect } from "next/navigation";
import { signUp } from "@/app/(auth)/signup/actions";
import { SIGN_UP_CHECK_EMAIL_MESSAGE } from "@/lib/auth/messages";
import { logError } from "@/lib/logging/logger";
import { SIGN_UP_TIMING_FLOOR_MS } from "@/lib/security/timing";

// Mock supabase client. mockSignUp is hoisted and shared so tests can
// configure its return value before calling signUp() and have that
// configuration actually apply to the call the action makes internally —
// createClient() must always return the SAME signUp mock instance, not a
// fresh vi.fn() per invocation.
const { mockSignUp, mockSignOut, mockInsert, mockWithTimingFloor } = vi.hoisted(
  () => ({
    mockSignUp: vi.fn(),
    mockSignOut: vi.fn(),
    mockInsert: vi.fn(),
    mockWithTimingFloor: vi.fn(),
  }),
);
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => ({
    auth: {
      signUp: mockSignUp,
      signOut: mockSignOut,
    },
  })),
}));

// signUp also writes a consent_logs row via the admin (service-role) client.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn().mockReturnValue({
      insert: mockInsert,
    }),
    auth: {
      admin: {
        deleteUser: vi.fn(),
      },
    },
  })),
}));

// The real floor is measured by bench/auth-enumeration; here it is recorded
// but not waited on, so the suite stays fast.
vi.mock("@/lib/security/timing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/timing")>()),
  withTimingFloor: mockWithTimingFloor,
}));

vi.mock("@/lib/logging/logger", () => ({
  logError: vi.fn(),
}));

// Mock redirect
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

function validForm(email = "user@example.com"): FormData {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", "validPassword123");
  formData.set("consent", "on");
  return formData;
}

const newUser = {
  id: "11111111-1111-1111-1111-111111111111",
  identities: [{ id: "identity" }],
};

beforeEach(() => {
  mockInsert.mockResolvedValue({ error: null });
  mockSignOut.mockResolvedValue({ error: null });
  mockWithTimingFloor.mockImplementation(
    (_floor: number, operation: () => Promise<unknown>) => operation(),
  );
});

describe("signUp server action", () => {
  it("rejects invalid email and password", async () => {
    const formData = new FormData();
    formData.set("email", "invalid-email");
    formData.set("password", "short");
    const result = await signUp(undefined, formData);
    expect(result?.error).toBe("Enter a valid email address");
  });

  it("records consent and returns the check-email outcome for a new account", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: newUser, session: null },
      error: null,
    });
    const result = await signUp(undefined, validForm());
    expect(result).toEqual({ info: SIGN_UP_CHECK_EMAIL_MESSAGE });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not redirect or keep a session when confirmations are disabled", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: newUser, session: {} as never },
      error: null,
    });
    const result = await signUp(undefined, validForm());
    expect(result).toEqual({ info: SIGN_UP_CHECK_EMAIL_MESSAGE });
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns an error for a weak password (independent of the email)", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: {
        code: "weak_password",
        status: 422,
        message: "Password is too weak",
      },
    });
    const result = await signUp(undefined, validForm());
    expect(result.error).toContain("password");
  });

  it("runs inside the sign-up timing floor", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: newUser, session: null },
      error: null,
    });
    await signUp(undefined, validForm());
    expect(mockWithTimingFloor).toHaveBeenCalledWith(
      SIGN_UP_TIMING_FLOOR_MS,
      expect.any(Function),
    );
  });
});

describe("signUp account-enumeration resistance (#527)", () => {
  const outcomes = {
    "a new account (confirmations on)": {
      data: { user: newUser, session: null },
      error: null,
    },
    "a new account (confirmations off)": {
      data: { user: newUser, session: {} },
      error: null,
    },
    "an existing account (obfuscated user, no identities)": {
      data: {
        user: { id: "22222222-2222-2222-2222-222222222222", identities: [] },
        session: null,
      },
      error: null,
    },
    "an existing account (user_already_exists error)": {
      data: { user: null, session: null },
      error: {
        code: "user_already_exists",
        status: 422,
        message: "User already registered",
      },
    },
    "an existing account (legacy message only)": {
      data: { user: null, session: null },
      error: { status: 400, message: "User already registered" },
    },
    "an email-send rate limit": {
      data: { user: null, session: null },
      error: {
        code: "over_email_send_rate_limit",
        status: 429,
        message: "email rate limit exceeded",
      },
    },
    "a per-address resend limit": {
      data: { user: null, session: null },
      error: {
        status: 429,
        message:
          "For security purposes, you can only request this after 30 seconds.",
      },
    },
  } as const;

  it("returns an identical body and never redirects, whether or not the email has an account", async () => {
    const results: Record<string, unknown> = {};
    for (const [label, response] of Object.entries(outcomes)) {
      mockSignUp.mockResolvedValueOnce(response);
      results[label] = await signUp(undefined, validForm());
    }

    const bodies = new Set(
      Object.values(results).map((r) => JSON.stringify(r)),
    );
    expect(bodies).toEqual(
      new Set([JSON.stringify({ info: SIGN_UP_CHECK_EMAIL_MESSAGE })]),
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not record consent for an email that already has an account", async () => {
    mockSignUp.mockResolvedValue(
      outcomes["an existing account (obfuscated user, no identities)"],
    );
    await signUp(undefined, validForm());
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("never logs the email address or the existing-account case", async () => {
    mockSignUp.mockResolvedValueOnce(
      outcomes["an existing account (user_already_exists error)"],
    );
    await signUp(undefined, validForm("patient@example.com"));
    expect(logError).not.toHaveBeenCalled();

    mockSignUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { status: 500, message: "Database error saving new user" },
    });
    await signUp(undefined, validForm("patient@example.com"));
    expect(logError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logError).mock.calls)).not.toContain(
      "patient@example.com",
    );
  });
});
