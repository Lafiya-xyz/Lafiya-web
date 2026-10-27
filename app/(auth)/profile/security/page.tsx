import type { Metadata } from "next";
import Link from "next/link";

import { deriveSecurityPosture } from "@/lib/account/security-posture";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Security center · Lafiya",
};

/**
 * Issue #807: one place to see how well the account is protected. Read-only
 * summary; every fix links to the existing flow (with its own step-up
 * checks) on the profile page rather than re-implementing it here.
 */
export default async function SecurityCenterPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: factors }, { data: sessions }] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.from("user_sessions").select("last_seen_at").eq("user_id", user.id),
  ]);

  const posture = deriveSecurityPosture({
    hasVerifiedMfa: (factors?.totp ?? []).some((f) => f.status === "verified"),
    sessionLastSeen: (sessions ?? []).map((s) => new Date(s.last_seen_at)),
    emailConfirmed: Boolean(user.email_confirmed_at),
    hasPendingEmailChange: Boolean(user.new_email),
  });
  const missing = posture.checks.filter((c) => !c.ok);

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6" aria-labelledby="security-heading">
      <h1 id="security-heading" className="text-xl font-semibold">
        Security center
      </h1>
      <p role="status" className="text-sm text-zinc-700 dark:text-zinc-300">
        Your account protection: <strong>{posture.score} out of 100</strong>.{" "}
        {missing.length === 0
          ? "Everything is turned on."
          : `${missing.length} thing${missing.length === 1 ? "" : "s"} to fix.`}
      </p>
      <ul className="flex flex-col gap-4">
        {posture.checks.map((check) => (
          <li
            key={check.id}
            className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
            aria-labelledby={`check-${check.id}`}
          >
            <h2 id={`check-${check.id}`} className="text-sm font-medium">
              <span aria-hidden="true">{check.ok ? "✓ " : "! "}</span>
              {check.title}
              <span className="sr-only">{check.ok ? " — on" : " — needs attention"}</span>
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{check.why}</p>
            {!check.ok ? (
              <Link href={check.fixHref} className="mt-2 inline-block text-sm underline">
                {check.fixLabel}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      <Link href="/profile" className="text-sm underline">
        Back to profile
      </Link>
    </main>
  );
}
