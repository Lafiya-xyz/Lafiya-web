import { computeRecordHash } from "@/lib/attestation/recordHash";
import { getSecretByUserId } from "@/lib/attestation/recordSecret";
import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/supabase/types";
import { validateAttestation } from "@/lib/stellar/attestation";
import { getBaseUrl } from "@/lib/url/getBaseUrl";

import { PreviewCardButton } from "./preview-card-button";
import { DownloadCardButton } from "./download-card-button";
import { SignOutButton } from "../signout/sign-out-button";
import { AttestationStatusBanner } from "./attestation-status-banner";
import { AccessSummary } from "./access-summary";
import { CapabilitySharePanel } from "./capability-share-panel";
import { DeleteAccountButton } from "./delete-account-button";
import { MissingSecretBanner } from "./missing-secret-banner";
import { LastChangeNotice, type RevisionSnapshot } from "./last-change-notice";
import { ProfileForm } from "./profile-form";
import { PrivacyControls } from "./privacy-controls";
import { QrCardDisplay } from "./qr-card-display";

/**
 * Detects "profile edited since last attestation" and opportunistically
 * records "verified as of this hash" once observed, so the next edit can
 * be detected against a known-good baseline. Never throws — an
 * attestation-layer hiccup (timeout, RPC error) must never produce a false
 * "please re-verify" prompt, so any failure here just means "no banner"
 * this render.
 */
async function checkAttestationStaleness(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: ProfileRow,
): Promise<{
  stale: boolean;
  pendingRequestExists: boolean;
  secretMissing: boolean;
}> {
  try {
    const secret = await getSecretByUserId(profile.user_id);
    if (!secret) {
      return { stale: false, pendingRequestExists: false, secretMissing: true };
    }

    const currentHash = computeRecordHash(profile, secret);
    const verified = await validateAttestation(currentHash);

    if (verified) {
      if (profile.last_attested_hash !== currentHash) {
        await supabase
          .from("profiles")
          .update({
            last_attested_hash: currentHash,
            last_verified_at: new Date().toISOString(),
          })
          .eq("user_id", profile.user_id);

        // Marking a queued request completed is a privileged write (no
        // update policy is granted to authenticated for this table — see
        // the reattestation_requests migration), so it goes through the
        // admin client, unlike the profiles update above.
        const admin = createAdminClient();
        await admin
          .from("reattestation_requests")
          .update({ status: "completed" })
          .eq("user_id", profile.user_id)
          .eq("record_hash", currentHash)
          .eq("status", "pending");
      }
      return {
        stale: false,
        pendingRequestExists: false,
        secretMissing: false,
      };
    }

    if (
      !profile.last_attested_hash ||
      profile.last_attested_hash === currentHash
    ) {
      return { stale: false, pendingRequestExists: false };
    }

    const { data: pending } = await supabase
      .from("reattestation_requests")
      .select("id")
      .eq("user_id", profile.user_id)
      .eq("record_hash", currentHash)
      .eq("status", "pending")
      .maybeSingle();

    return {
      stale: true,
      pendingRequestExists: pending !== null,
      secretMissing: false,
    };
  } catch (err) {
    logError("Failed to check attestation status", err, {
      route: "/profile",
    });
    return { stale: false, pendingRequestExists: false, secretMissing: false };
  }
}

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

  const { stale, pendingRequestExists, secretMissing } = profile
    ? await checkAttestationStaleness(supabase, profile)
    : { stale: false, pendingRequestExists: false };
  const { data: consentEvents } = await supabase
    .from("consent_events")
    .select("*")
    .eq("user_id", user.id)
    .order("occurred_at", { ascending: false });
  const { data: accessSummary } = await supabase.rpc(
    "get_my_card_access_summary",
  );
  const { data: recentRevisions } = profile
    ? await supabase
        .from("record_revisions")
        .select("created_at, emergency_data")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(2)
    : { data: null };
  const [latestRevision, previousRevision] = (recentRevisions ??
    []) as unknown as RevisionSnapshot[];
  const { data: activeCapabilities } = profile
    ? await supabase
        .from("emergency_capabilities")
        .select(
          "id, purpose, field_allowlist, issued_at, expires_at, max_views, used_views",
        )
        .eq("user_id", user.id)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("issued_at", { ascending: false })
    : { data: null };

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
        <>
          <QrCardDisplay
            cardUrl={`${await getBaseUrl()}/card/${profile.card_public_id}`}
            legacySunsetAt={profile.legacy_card_sunset_at}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Preview shows your last-saved public card. Unsaved draft changes
            are not reflected until you save.
          </p>
          <div className="flex flex-wrap gap-3">
            <PreviewCardButton
              cardUrl={`${await getBaseUrl()}/card/${profile.card_public_id}`}
            />
            <DownloadCardButton
              cardUrl={`${await getBaseUrl()}/card/${profile.card_public_id}`}
              card={{
                name: profile.name,
                age: null,
                blood_group: profile.blood_group,
                genotype: profile.genotype,
                allergies: profile.allergies,
                medications: profile.medications,
                chronic_conditions: profile.chronic_conditions,
                emergency_contacts: profile.emergency_contacts,
                language: profile.language,
                record_updated_at: profile.updated_at,
              }}
            />
          </div>
        </>
      ) : null}

      {profile ? (
        <CapabilitySharePanel activeCapabilities={activeCapabilities ?? []} />
      ) : null}

      <AccessSummary
        viewsLast30Days={accessSummary?.[0]?.views_last_30_days ?? 0}
        lastViewedAt={accessSummary?.[0]?.last_viewed_at ?? null}
      />

      {stale ? (
        <AttestationStatusBanner pendingRequestExists={pendingRequestExists} />
      ) : null}

      {latestRevision ? (
        <LastChangeNotice
          latest={latestRevision}
          previous={previousRevision ?? null}
        />
      ) : null}

      <ProfileForm profile={profile} userId={user.id} />

      {profile?.current_revision_id ? (
        <PrivacyControls
          revisionId={profile.current_revision_id}
          policy={profile.disclosure_policy}
          events={consentEvents ?? []}
        />
      ) : null}

      <hr className="border-zinc-200 dark:border-zinc-800" />

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-red-600 dark:text-red-400">
          Danger zone
        </h2>
        <DeleteAccountButton />
      </div>
    </div>
  );
}
