/**
 * Issue #522: exportMyProfileData, deleteAccount, repairProfileSecret, and
 * regenerateCardId must all fail closed with STEP_UP_REQUIRED when the
 * caller's session doesn't satisfy aal2 but the user *has* a verified MFA
 * factor enrolled (nextLevel === "aal2") -- and must be entirely unaffected
 * (their pre-#522 behavior) when the user has no factor enrolled at all
 * (nextLevel stays "aal1").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/attestation/recordSecret", () => ({
  ensureRecordSecret: vi.fn(),
  secretExistsByUserId: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/account/deleteAccount", () => ({
  deleteAccountAndData: vi.fn(),
}));
vi.mock("@/lib/logging/logger", () => ({ logError: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { ensureRecordSecret } from "@/lib/attestation/recordSecret";
import { deleteAccountAndData } from "@/lib/account/deleteAccount";
import { STEP_UP_REQUIRED } from "@/lib/auth/assurance";
import {
  deleteAccount,
  exportMyProfileData,
  regenerateCardId,
  repairProfileSecret,
} from "./actions";

const USER = { id: "user-step-up-test" };

function mfa(currentLevel: "aal1" | "aal2", nextLevel: "aal1" | "aal2") {
  return {
    getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
      data: { currentLevel, nextLevel, currentAuthenticationMethods: [] },
      error: null,
    }),
  };
}

function mockClient(mfaMock: ReturnType<typeof mfa>) {
  // The result of .select(...).eq(...) needs to support whichever terminal
  // method the real code calls next (.single() for the profile row,
  // .order() for the revisions/consents/requests lists, .maybeSingle() for
  // regenerateCardId's current-id lookup) -- all on the same chain result.
  const eqResult = {
    single: vi.fn().mockResolvedValue({
      data: { user_id: USER.id, card_public_id: "card-id" },
      error: null,
    }),
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: { user_id: USER.id }, error: null }),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: USER }, error: null }),
      mfa: mfaMock,
      signOut: vi.fn(),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue(eqResult) }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
    storage: {
      from: vi.fn().mockReturnValue({
        list: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    },
  };
  vi.mocked(createClient).mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  return client;
}

function formData(entries: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

describe("Issue #522 step-up guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("blocked when MFA is enrolled but the session is only aal1", () => {
    it("exportMyProfileData returns STEP_UP_REQUIRED and never touches profile data", async () => {
      const client = mockClient(mfa("aal1", "aal2"));

      const result = await exportMyProfileData();

      expect(result).toMatchObject({ code: STEP_UP_REQUIRED });
      expect(client.from).not.toHaveBeenCalled();
    });

    it("deleteAccount returns STEP_UP_REQUIRED even with a correct confirmation, and never deletes anything", async () => {
      mockClient(mfa("aal1", "aal2"));

      const result = await deleteAccount(undefined, formData({ confirm: "DELETE" }));

      expect(result).toMatchObject({ code: STEP_UP_REQUIRED });
      expect(deleteAccountAndData).not.toHaveBeenCalled();
    });

    it("repairProfileSecret returns status: step_up_required and never provisions a secret", async () => {
      mockClient(mfa("aal1", "aal2"));

      const result = await repairProfileSecret();

      expect(result).toEqual({ status: "step_up_required" });
      expect(ensureRecordSecret).not.toHaveBeenCalled();
    });

    it("regenerateCardId returns STEP_UP_REQUIRED and never rotates the card id", async () => {
      const client = mockClient(mfa("aal1", "aal2"));

      const result = await regenerateCardId(undefined, formData());

      expect(result).toMatchObject({ code: STEP_UP_REQUIRED });
      // Only the auth check ran -- no table access for the actual rotation.
      expect(client.from).not.toHaveBeenCalled();
    });
  });

  describe("allowed once the session has stepped up to aal2", () => {
    it("exportMyProfileData proceeds normally", async () => {
      mockClient(mfa("aal2", "aal2"));

      const result = await exportMyProfileData();

      expect("data" in result).toBe(true);
    });

    it("repairProfileSecret proceeds normally", async () => {
      mockClient(mfa("aal2", "aal2"));
      vi.mocked(ensureRecordSecret).mockResolvedValueOnce("new-secret");

      const result = await repairProfileSecret();

      expect(result.status).not.toBe("step_up_required");
      expect(ensureRecordSecret).toHaveBeenCalledWith(USER.id);
    });
  });

  describe("unaffected when the user has no MFA factor enrolled at all", () => {
    it("exportMyProfileData proceeds normally (nextLevel stays aal1)", async () => {
      mockClient(mfa("aal1", "aal1"));

      const result = await exportMyProfileData();

      expect("data" in result).toBe(true);
    });

    it("repairProfileSecret proceeds normally (nextLevel stays aal1)", async () => {
      mockClient(mfa("aal1", "aal1"));
      vi.mocked(ensureRecordSecret).mockResolvedValueOnce("new-secret");

      const result = await repairProfileSecret();

      expect(result.status).not.toBe("step_up_required");
    });

    it("regenerateCardId proceeds normally (nextLevel stays aal1)", async () => {
      const client = mockClient(mfa("aal1", "aal1"));

      const result = await regenerateCardId(undefined, formData());

      expect(result.code).toBeUndefined();
      expect(client.from).toHaveBeenCalled();
    });
  });

  describe("fails closed when the assurance level can't be determined", () => {
    it("exportMyProfileData returns STEP_UP_REQUIRED rather than proceeding", async () => {
      mockClient({
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: null,
          error: new Error("network error"),
        }),
      });

      const result = await exportMyProfileData();

      expect(result).toMatchObject({ code: STEP_UP_REQUIRED });
    });
  });
});
