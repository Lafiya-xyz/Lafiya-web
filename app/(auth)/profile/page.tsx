import type { Metadata } from "next";
import Link from "next/link";

import { computeRecordHash } from "@/lib/attestation/recordHash";
import { getSecretByUserId } from "@/lib/attestation/recordSecret";
import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/supabase/types";
import { validateAttestation } from "@/lib/stellar/attestation";
import { sessionIdFromAccessToken } from "@/lib/sessions/throttle";
import { coarseUserAgent } from "@/lib/sessions/user-agent";
import { getBaseUrl } from "@/lib/url/getBaseUrl";
import { getAvatarSignedUrl } from "@/lib/storage/avatar";

import { PreviewCardButton } from "./preview-card-button";
import { DownloadCardButton } from "./download-card-button";
import { ProfileCompleteness } from "./profile-completeness";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "../signout/sign-out-button";
import { AttestationStatusBanner } from "./attestation-status-banner";
import { AccessSummary } from "./access-summary";
import { NotificationInbox } from "./notification-inbox";
import { VerificationVisitPanel } from "./verification-visit-panel";
import type { VisitRequest } from "@/lib/chw-protocol/visit-requests";
import type { InboxNotification } from "@/lib/notifications/inbox";
import { CapabilitySharePanel } from "./capability-share-panel";
import { DeleteAccountButton } from "./delete-account-button";
import { EmailChangePanel } from "./email-change-panel";
import { MfaEnrollment } from "./mfa-enrollment";
import { MissingSecretBanner } from "./missing-secret-banner";
import { LastChangeNotice, type RevisionSnapshot } from "./last-change-notice";
import { ProfileForm } from "./profile-form";
import { PrivacyControls } from "./privacy-controls";
import { QrCardDisplay } from "./qr-card-display";
import { SessionsPanel, type SessionListItem } from "./sessions-panel";
import { NotificationPreferencesPanel } from "./notification-preferences-panel";
import { fromRow as preferencesFromRow } from "@/lib/notifications/preferences";
import { isEmailUnreachable } from "@/lib/notifications";

export const metadata: Metadata = {
  title: "Your Profile · Lafiya",
};

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

/**
 * Static shell: navigation, headings and help text that do not depend on
 * the authenticated user. Rendered as part of the prerendered shell so it
 * streams instantly while the user-specific sections below resolve behind
 * Suspense boundaries.
 */
function ProfileShellHeader() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
          Your Lafiya card
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Manage your emergency card, sharing and privacy settings.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <SignOutButton />
      </div>
    </div>
  );
}

/**
 * User-specific sections. Each boundary reads the authenticated user's own
 * data via the request-scoped Supabase client, so nothing here is cached
 * across users — the shell above is the only prerendered part.
 */
async function ProfileContent() {
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

  const { data: notifications } = await (supabase as any)
    .from("user_notifications")
    .select("id, type, body_key, created_at, read_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: visitRequest } = await (supabase as any)
    .from("verification_requests")
    .select(
      "id, status, lga, preferred_language, contact_preference, contact_consent, contact_phone, matched_chw_id, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const { stale, pendingRequestExists, secretMissing } = profile
    ? await checkAttestationStaleness(supabase, profile)
    : { stale: false, pendingRequestExists: false, secretMissing: false };
  const { data: notificationPrefsRow } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_preferences" as any)
    .select("timezone, quiet_start, quiet_end, channels, batch_low_priority")
    .eq("user_id", user.id)
    .maybeSingle();
  const emailUnreachable = user.email
    ? await isEmailUnreachable(user.email).catch(() => false)
    : false;
  const { data: consentEvents } = await supabase
    .from("consent_events")
    .select("*")
    .eq("user_id", user.id)
    .order("occurred_at", { ascending: false });
  const { data: accessSummary } = await supabase.rpc(
    "get_my_card_access_summary",
  );
  const { data: pinAccessSummary } = await supabase.rpc(
    "get_my_card_pin_access_summary",
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
  const sessions = await loadSessions(supabase);

  // Issue #528: resolve a signed URL for the avatar photo server-side.
  // The owner is the authenticated user so authorization is established.
  const signedPhotoUrl = profile?.photo_url
    ? await getAvatarSignedUrl(profile.photo_url)
    : null;

  // Issue #531: fetch the guardian's dependant profiles.
  const { data: dependants } = await supabase.rpc("get_my_dependants");

  return (
    <>
      <div>
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          {profile ? profile.name : "Your Lafiya card"}
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {user.email}
        </p>
      </div>

      {profile ? (
        <>
          <QrCardDisplay
            cardUrl={`${await getBaseUrl()}/card/${profile.card_public_id}`}
            legacySunsetAt={profile.legacy_card_sunset_at}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Preview shows your last-saved public card. Unsaved draft changes are
            not reflected until you save.
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
          <ProfileCompleteness profile={profile} />
          <WallpaperGenerator />
        </>
      ) : null}

      {profile ? (
        <CapabilitySharePanel
          activeCapabilities={activeCapabilities ?? []}
          printableCard={
            profile
              ? {
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
                }
              : undefined
          }
        />
      ) : null}

      <VerificationVisitPanel
        request={(visitRequest as VisitRequest | null) ?? null}
      />

      <NotificationInbox
        userId={user.id}
        initial={(notifications as InboxNotification[] | null) ?? []}
      />

      <AccessSummary
        viewsLast30Days={accessSummary?.[0]?.views_last_30_days ?? 0}
        lastViewedAt={accessSummary?.[0]?.last_viewed_at ?? null}
        pinSuccesses={pinAccessSummary?.[0]?.pin_successes_30d ?? 0}
        pinFailures={pinAccessSummary?.[0]?.pin_failures_30d ?? 0}
        lastPinFailureAt={pinAccessSummary?.[0]?.last_pin_failure_at ?? null}
      />

      {stale ? (
        <AttestationStatusBanner pendingRequestExists={pendingRequestExists} />
      ) : null}

      {secretMissing ? <MissingSecretBanner /> : null}

      {profile ? (
        <LastChangeNotice
          latest={latestRevision ?? null}
          previous={previousRevision ?? null}
        />
      ) : null}

      {profile ? <ProfileForm profile={profile} /> : null}

      <PrivacyControls consentEvents={consentEvents ?? []} />

      <DeleteAccountButton />
    </>
  );
}

      <div id="security-sessions">
        <SessionsPanel sessions={sessions} />
      </div>

      <hr className="border-zinc-200 dark:border-zinc-800" />

      <NotificationPreferencesPanel
        preferences={preferencesFromRow(
          notificationPrefsRow as Parameters<typeof preferencesFromRow>[0],
        )}
        emailUnreachable={emailUnreachable}
      />

      <hr className="border-zinc-200 dark:border-zinc-800" />

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Security
        </h2>
        <Link
          href="/profile/security"
          className="text-sm text-zinc-700 underline dark:text-zinc-300"
        >
          Open security center
        </Link>
        <MfaEnrollment />
      </div>

      <div id="security-email">
        <EmailChangePanel
          currentEmail={user.email ?? ""}
          hasPendingChange={Boolean(user.new_email)}
        />
      </div>

      <PrivacyControls consentEvents={consentEvents ?? []} />

      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-red-600 dark:text-red-400">
          Danger zone
        </h2>
        <Link
          href="/profile/merge"
          className="text-sm text-zinc-700 underline dark:text-zinc-300"
        >
          Have a duplicate account? Merge it into this one
        </Link>
        <DeleteAccountButton />
      </div>
    </div>
  );
}
