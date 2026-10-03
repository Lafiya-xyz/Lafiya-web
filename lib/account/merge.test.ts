import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  executeMerge,
  MergeError,
  startMergeRequest,
  verifyMergeRequest,
  type OtpVerifier,
} from "./merge";

const requester = { id: "user-a", email: "a@example.com" };

type Request = {
  id: string;
  requester_user_id: string;
  other_user_id: string | null;
  status: string;
  expires_at: string;
};

// Minimal fake of the admin client surface the merge flow uses.
function fakeAdmin(options: {
  users?: Record<string, string>;
  shareKey?: boolean;
  mergeError?: { message: string } | null;
}) {
  const requests = new Map<string, Request>();
  const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
    switch (name) {
      case "find_user_id_by_email":
        return { data: options.users?.[args.p_email] ?? null, error: null };
      case "accounts_share_blocking_key":
        return { data: options.shareKey ?? true, error: null };
      case "merge_patient_accounts":
        if (options.mergeError)
          return { data: null, error: options.mergeError };
        requests.get(args.p_merge_request_id)!.status = "merged";
        return {
          data: { id: "audit-1", adjusted_obligations: 1 },
          error: null,
        };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
  const from = vi.fn(() => {
    const filters: Record<string, string> = {};
    let pendingUpdate: Partial<Request> | null = null;
    const builder = {
      insert(row: Omit<Request, "id" | "status">) {
        const id = `req-${requests.size + 1}`;
        requests.set(id, { ...row, id, status: "pending" });
        return {
          select: () => ({
            single: async () => ({ data: { id }, error: null }),
          }),
        };
      },
      select() {
        return builder;
      },
      update(values: Partial<Request>) {
        pendingUpdate = values;
        return builder;
      },
      eq(column: string, value: string) {
        filters[column] = value;
        if (pendingUpdate && column === "status") {
          const request = requests.get(filters.id);
          if (request?.status === value) Object.assign(request, pendingUpdate);
          return Promise.resolve({ error: null });
        }
        return builder;
      },
      async maybeSingle() {
        const request = requests.get(filters.id);
        const matches =
          request &&
          (!filters.requester_user_id ||
            request.requester_user_id === filters.requester_user_id);
        return { data: matches ? request : null, error: null };
      },
    };
    return builder;
  });
  return {
    admin: { rpc, from } as unknown as Parameters<typeof startMergeRequest>[0],
    requests,
    rpc,
  };
}

function otp(validCodes: Record<string, string>): OtpVerifier & {
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    send: async (email) => {
      sent.push(email);
    },
    verify: async (email, code) => validCodes[email] === code,
  };
}

describe("verified account merge (issue #628)", () => {
  let codes: ReturnType<typeof otp>;
  beforeEach(() => {
    codes = otp({ "a@example.com": "111111", "b@example.com": "222222" });
  });

  it("sends a code to both accounts and merges only after dual verification", async () => {
    const { admin, requests, rpc } = fakeAdmin({
      users: { "b@example.com": "user-b" },
    });
    const requestId = await startMergeRequest(
      admin,
      codes,
      requester,
      "b@example.com",
    );
    expect(codes.sent).toEqual(["a@example.com", "b@example.com"]);

    // A merge before verification is refused by the flow (and by SQL).
    await expect(
      verifyMergeRequest(admin, codes, requester, {
        requestId,
        otherEmail: "b@example.com",
        requesterCode: "111111",
        otherCode: "999999",
      }),
    ).rejects.toEqual(new MergeError("VERIFICATION_FAILED"));
    expect(requests.get(requestId)!.status).toBe("pending");

    await verifyMergeRequest(admin, codes, requester, {
      requestId,
      otherEmail: "b@example.com",
      requesterCode: "111111",
      otherCode: "222222",
    });
    expect(requests.get(requestId)!.status).toBe("verified");

    await expect(
      executeMerge(admin, requester.id, requestId, "user-a"),
    ).resolves.toEqual({ auditId: "audit-1", adjustedObligations: 1 });
    expect(rpc).toHaveBeenCalledWith("merge_patient_accounts", {
      p_merge_request_id: requestId,
      p_survivor_user_id: "user-a",
    });
  });

  it("never merges accounts that share no blocking key", async () => {
    const { admin, requests } = fakeAdmin({
      users: { "b@example.com": "user-b" },
      shareKey: false,
    });
    const requestId = await startMergeRequest(
      admin,
      codes,
      requester,
      "b@example.com",
    );
    await expect(
      verifyMergeRequest(admin, codes, requester, {
        requestId,
        otherEmail: "b@example.com",
        requesterCode: "111111",
        otherCode: "222222",
      }),
    ).rejects.toEqual(new MergeError("NOT_A_DUPLICATE"));
    expect(requests.get(requestId)!.status).toBe("pending");
  });

  it("does not reveal whether the other account exists", async () => {
    const { admin } = fakeAdmin({});
    const requestId = await startMergeRequest(
      admin,
      codes,
      requester,
      "nobody@example.com",
    );
    expect(requestId).toBeTruthy();
    expect(codes.sent).toEqual(["a@example.com"]);
    await expect(
      verifyMergeRequest(admin, codes, requester, {
        requestId,
        otherEmail: "nobody@example.com",
        requesterCode: "111111",
        otherCode: "000000",
      }),
    ).rejects.toEqual(new MergeError("VERIFICATION_FAILED"));
  });

  it("refuses to merge an account with itself", async () => {
    const { admin } = fakeAdmin({});
    await expect(
      startMergeRequest(admin, codes, requester, "A@example.com"),
    ).rejects.toEqual(new MergeError("SAME_ACCOUNT"));
  });

  it("leaves the request verified when the merge transaction rolls back", async () => {
    const { admin, requests } = fakeAdmin({
      users: { "b@example.com": "user-b" },
      mergeError: { message: "deadlock detected" },
    });
    const requestId = await startMergeRequest(
      admin,
      codes,
      requester,
      "b@example.com",
    );
    await verifyMergeRequest(admin, codes, requester, {
      requestId,
      otherEmail: "b@example.com",
      requesterCode: "111111",
      otherCode: "222222",
    });
    await expect(
      executeMerge(admin, requester.id, requestId, "user-a"),
    ).rejects.toEqual(new MergeError("MERGE_FAILED"));
    expect(requests.get(requestId)!.status).toBe("verified");
  });

  it("only lets the requester execute their own request", async () => {
    const { admin } = fakeAdmin({ users: { "b@example.com": "user-b" } });
    const requestId = await startMergeRequest(
      admin,
      codes,
      requester,
      "b@example.com",
    );
    await expect(
      executeMerge(admin, "user-c", requestId, "user-c"),
    ).rejects.toEqual(new MergeError("REQUEST_NOT_FOUND"));
  });
});
