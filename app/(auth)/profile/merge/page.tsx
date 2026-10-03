import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { countDuplicateCandidates } from "@/lib/account/duplicates";
import { serverEnv } from "@/lib/env-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { completeMerge, startMerge, verifyMerge } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Merge duplicate accounts",
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  DISABLED: "Account merging is not available right now.",
  VALIDATION: "Enter the email address of your other account.",
  SAME_ACCOUNT: "That is the account you are signed in to.",
  REQUEST_NOT_FOUND: "This merge request has expired. Start again.",
  VERIFICATION_FAILED:
    "One or both codes were not correct. Check both inboxes and try again.",
  NOT_A_DUPLICATE:
    "These accounts do not appear to belong to the same person, so they cannot be merged.",
  MERGE_FAILED: "The merge could not be completed. Nothing was changed.",
};

const inputClass =
  "min-h-11 rounded-md border border-zinc-300 px-3 dark:border-zinc-700 dark:bg-zinc-900";
const buttonClass =
  "min-h-11 self-start rounded-full bg-zinc-950 px-5 py-2 text-white dark:bg-zinc-50 dark:text-zinc-950";

/**
 * Issue #628: verified, auditable merge of duplicate patient accounts. The
 * other account's details are shown only after one-time codes sent to BOTH
 * accounts have been verified; the merge itself is one database transaction.
 */
export default async function MergeAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; error?: string; merged?: string }>;
}) {
  const { request: requestId, error, merged } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const enabled = Boolean(serverEnv.ACCOUNT_LINKAGE_HMAC_SECRET);
  const admin = createAdminClient();
  const candidates = enabled
    ? await countDuplicateCandidates(admin, user.id).catch(() => 0)
    : 0;

  const { data: request } =
    enabled && requestId && /^[0-9a-f-]{36}$/i.test(requestId)
      ? await admin
          .from("account_merge_requests")
          .select("id, status, other_user_id, expires_at")
          .eq("id", requestId)
          .eq("requester_user_id", user.id)
          .maybeSingle()
      : { data: null };

  const verified =
    request?.status === "verified" && request.other_user_id !== null;
  const { data: profiles } = verified
    ? await admin
        .from("profiles")
        .select("user_id, name, date_of_birth, updated_at")
        .in("user_id", [user.id, request.other_user_id as string])
    : { data: null };

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">Merge duplicate accounts</h1>
      {error && ERRORS[error] ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {ERRORS[error]}
        </p>
      ) : null}

      {merged ? (
        <p role="status">
          Your accounts were merged. Cards printed for the removed account no
          longer work; issue a new card from your profile. We sent a
          notification to both email addresses.
        </p>
      ) : !enabled ? (
        <p>{ERRORS.DISABLED}</p>
      ) : verified && profiles ? (
        <form action={completeMerge} className="flex flex-col gap-3">
          <input type="hidden" name="requestId" value={request.id} />
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">
              Which profile should we keep?
            </legend>
            {profiles.map((profile) => (
              <label key={profile.user_id} className="flex gap-2">
                <input
                  type="radio"
                  name="survivorUserId"
                  value={profile.user_id}
                  required
                  defaultChecked={profile.user_id === user.id}
                />
                <span>
                  {profile.name}
                  {profile.date_of_birth
                    ? ` · born ${profile.date_of_birth}`
                    : ""}
                  {" · "}last updated {profile.updated_at.slice(0, 10)}
                  {profile.user_id === user.id ? " (signed in)" : ""}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The other profile&apos;s history is kept in this record&apos;s
            timeline. Its card links stop working immediately. This cannot be
            undone.
          </p>
          <button type="submit" className={buttonClass}>
            Merge accounts
          </button>
        </form>
      ) : request?.status === "pending" ? (
        <form action={verifyMerge} className="flex flex-col gap-3">
          <input type="hidden" name="requestId" value={request.id} />
          <p className="text-sm">
            If the other account exists, both accounts were sent a one-time code
            by email.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Code sent to {user.email}
            <input
              name="requesterCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Other account&apos;s email
            <input
              name="otherEmail"
              type="email"
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Code sent to the other account
            <input
              name="otherCode"
              inputMode="numeric"
              autoComplete="off"
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonClass}>
            Verify both accounts
          </button>
        </form>
      ) : (
        <form action={startMerge} className="flex flex-col gap-3">
          {candidates > 0 ? (
            <p role="status" className="text-sm">
              We found{" "}
              {candidates === 1
                ? "another account"
                : `${candidates} other accounts`}{" "}
              that may belong to you. Nothing is merged unless you verify both
              accounts.
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            Email of your other Lafiya account
            <input
              name="otherEmail"
              type="email"
              required
              className={inputClass}
            />
          </label>
          <button type="submit" className={buttonClass}>
            Send verification codes
          </button>
        </form>
      )}
      <Link href="/profile" className="text-sm underline">
        Back to profile
      </Link>
    </main>
  );
}
