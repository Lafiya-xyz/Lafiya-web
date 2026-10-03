"use server";

import { redirect } from "next/navigation";

import {
  executeMerge,
  MergeError,
  startMergeRequest,
  verifyMergeRequest,
} from "@/lib/account/merge";
import { supabaseEmailOtp } from "@/lib/account/otp";
import { serverEnv } from "@/lib/env-server";
import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const MERGE_PATH = "/profile/merge";

async function requireUser() {
  if (!serverEnv.ACCOUNT_LINKAGE_HMAC_SECRET) {
    redirect(`${MERGE_PATH}?error=DISABLED`);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/signin");
  return { id: user.id, email: user.email };
}

function errorCode(error: unknown): string {
  if (error instanceof MergeError) return error.code;
  logError("Account merge step failed", error, { route: MERGE_PATH });
  return "MERGE_FAILED";
}

/** Issue #628, step 1: send a one-time code to both accounts. */
export async function startMerge(formData: FormData): Promise<void> {
  const requester = await requireUser();
  const otherEmail = formData.get("otherEmail");
  if (typeof otherEmail !== "string" || !otherEmail.includes("@")) {
    redirect(`${MERGE_PATH}?error=VALIDATION`);
  }
  let requestId: string;
  try {
    requestId = await startMergeRequest(
      createAdminClient(),
      supabaseEmailOtp,
      requester,
      otherEmail,
    );
  } catch (error) {
    redirect(`${MERGE_PATH}?error=${errorCode(error)}`);
  }
  redirect(`${MERGE_PATH}?request=${requestId}`);
}

/** Step 2: both codes must verify before the other account is shown. */
export async function verifyMerge(formData: FormData): Promise<void> {
  const requester = await requireUser();
  const requestId = String(formData.get("requestId") ?? "");
  try {
    await verifyMergeRequest(createAdminClient(), supabaseEmailOtp, requester, {
      requestId,
      otherEmail: String(formData.get("otherEmail") ?? ""),
      requesterCode: String(formData.get("requesterCode") ?? ""),
      otherCode: String(formData.get("otherCode") ?? ""),
    });
  } catch (error) {
    redirect(
      `${MERGE_PATH}?request=${encodeURIComponent(requestId)}&error=${errorCode(error)}`,
    );
  }
  redirect(`${MERGE_PATH}?request=${encodeURIComponent(requestId)}`);
}

/** Step 3: merge atomically into the profile the owner chose to keep. */
export async function completeMerge(formData: FormData): Promise<void> {
  const requester = await requireUser();
  const requestId = String(formData.get("requestId") ?? "");
  try {
    await executeMerge(
      createAdminClient(),
      requester.id,
      requestId,
      String(formData.get("survivorUserId") ?? ""),
    );
  } catch (error) {
    redirect(
      `${MERGE_PATH}?request=${encodeURIComponent(requestId)}&error=${errorCode(error)}`,
    );
  }
  redirect(`${MERGE_PATH}?merged=1`);
}
