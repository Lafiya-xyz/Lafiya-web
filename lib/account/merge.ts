import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

export const MERGE_REQUEST_TTL_MS = 15 * 60 * 1000;

/** Sends and checks one-time codes; backed by Supabase email OTP. */
export type OtpVerifier = {
  send(email: string): Promise<void>;
  verify(email: string, code: string): Promise<boolean>;
};

export class MergeError extends Error {
  constructor(
    readonly code:
      | "SAME_ACCOUNT"
      | "REQUEST_NOT_FOUND"
      | "VERIFICATION_FAILED"
      | "NOT_A_DUPLICATE"
      | "MERGE_FAILED",
  ) {
    super(code);
    this.name = "MergeError";
  }
}

/**
 * Step 1: the signed-in owner names the other account's email. Codes go to
 * both addresses. Whether the other account exists is never revealed: an
 * unknown email still gets a request (that can never verify).
 */
export async function startMergeRequest(
  admin: AdminClient,
  otp: OtpVerifier,
  requester: { id: string; email: string },
  otherEmail: string,
): Promise<string> {
  if (otherEmail.trim().toLowerCase() === requester.email.toLowerCase()) {
    throw new MergeError("SAME_ACCOUNT");
  }
  const { data: otherUserId } = await admin.rpc("find_user_id_by_email", {
    p_email: otherEmail,
  });
  const { data, error } = await admin
    .from("account_merge_requests")
    .insert({
      requester_user_id: requester.id,
      other_user_id:
        otherUserId && otherUserId !== requester.id ? otherUserId : null,
      expires_at: new Date(Date.now() + MERGE_REQUEST_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new MergeError("MERGE_FAILED");
  await otp.send(requester.email);
  if (otherUserId) await otp.send(otherEmail);
  return data.id;
}

/**
 * Step 2: both codes must verify. Only then, and only if the accounts share
 * a blocking key, is the request marked verified. No detail of the other
 * account is shown before this point.
 */
export async function verifyMergeRequest(
  admin: AdminClient,
  otp: OtpVerifier,
  requester: { id: string; email: string },
  input: {
    requestId: string;
    otherEmail: string;
    requesterCode: string;
    otherCode: string;
  },
): Promise<void> {
  const { data: request } = await admin
    .from("account_merge_requests")
    .select("id, other_user_id, status, expires_at")
    .eq("id", input.requestId)
    .eq("requester_user_id", requester.id)
    .maybeSingle();
  if (
    !request ||
    request.status !== "pending" ||
    new Date(request.expires_at).getTime() <= Date.now()
  ) {
    throw new MergeError("REQUEST_NOT_FOUND");
  }
  const [requesterOk, otherOk] = await Promise.all([
    otp.verify(requester.email, input.requesterCode),
    otp.verify(input.otherEmail, input.otherCode),
  ]);
  const { data: otherUserId } = await admin.rpc("find_user_id_by_email", {
    p_email: input.otherEmail,
  });
  if (
    !requesterOk ||
    !otherOk ||
    !request.other_user_id ||
    otherUserId !== request.other_user_id
  ) {
    throw new MergeError("VERIFICATION_FAILED");
  }
  const { data: shared } = await admin.rpc("accounts_share_blocking_key", {
    p_a: requester.id,
    p_b: request.other_user_id,
  });
  if (!shared) throw new MergeError("NOT_A_DUPLICATE");
  const now = new Date().toISOString();
  const { error } = await admin
    .from("account_merge_requests")
    .update({
      status: "verified",
      requester_verified_at: now,
      other_verified_at: now,
    })
    .eq("id", request.id)
    .eq("status", "pending");
  if (error) throw new MergeError("MERGE_FAILED");
}

/**
 * Step 3: the owner picks the surviving profile. The merge runs as one
 * database transaction (merge_patient_accounts): on any failure nothing is
 * changed and the request stays verified so the owner can retry.
 */
export async function executeMerge(
  admin: AdminClient,
  requesterId: string,
  requestId: string,
  survivorUserId: string,
): Promise<{ auditId: string; adjustedObligations: number }> {
  const { data: request } = await admin
    .from("account_merge_requests")
    .select("id")
    .eq("id", requestId)
    .eq("requester_user_id", requesterId)
    .maybeSingle();
  if (!request) throw new MergeError("REQUEST_NOT_FOUND");
  const { data, error } = await admin.rpc("merge_patient_accounts", {
    p_merge_request_id: requestId,
    p_survivor_user_id: survivorUserId,
  });
  if (error || !data) {
    throw new MergeError(
      error?.message.includes("NOT_A_DUPLICATE")
        ? "NOT_A_DUPLICATE"
        : "MERGE_FAILED",
    );
  }
  return { auditId: data.id, adjustedObligations: data.adjusted_obligations };
}
