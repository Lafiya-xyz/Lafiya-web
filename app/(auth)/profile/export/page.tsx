import { createClient } from "@/lib/supabase/server";
import { getBaseUrl } from "@/lib/url/getBaseUrl";

import { SignOutButton } from "../signout/sign-out-button";
import { ProfileForm } from "./profile-form";
import { QrCardDisplay } from "./qr-card-display";

export default async function ProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // proxy.ts already redirects unauthenticated requests away from this
  // route; this only defends against a direct-render race, not the
  // primary access check.
  if (!user) {
    return null;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
            {profile ? profile.name : "Your Lafiya card"}
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {user.email}
          </p>
        </div>
        <SignOutButton />
      </div>

      {profile ? (
        <QrCardDisplay
          cardUrl={`${await getBaseUrl()}/card/${profile.card_public_id}`}
        />
      ) : null}

      <ProfileForm profile={profile} userId={user.id} />

      {profile ? (
        <div className="border-t border-zinc-200 pt-6 dark:border-zinc-800">
          
            href="/profile/export"
            download
            className="inline-flex items-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Download my data
          </a>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Download a copy of everything we store about you as a JSON file.
          </p>
        </div>
      ) : null}
    </div>
  );
}