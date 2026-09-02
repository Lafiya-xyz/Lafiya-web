"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";

import { deleteAccountAndData } from "@/lib/account/deleteAccount";
import { ensureRecordSecret } from "@/lib/attestation/recordSecret";
import {
  createRawCapability,
  digestCapability,
  EMERGENCY_FIELD_ALLOWLIST,
} from "@/lib/emergency/capability";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/supabase/types";
import type { ConsentPurpose, DisclosurePolicy } from "@/lib/supabase/types";
import { profileFormSchema } from "@/lib/validation/profile";
import {
  computeRevisionCommitment,
  DEFAULT_DISCLOSURE_POLICY,
  normalizeEmergencyRecord,
} from "@/lib/records/canonicalization";

import { logError } from "@/lib/logging/logger";
import { getBaseUrl } from "@/lib/url/getBaseUrl";

export interface ProfileFormState {
  error?: string;
  errors?: Record<string, string>;
  success?: boolean;
  code?: "STALE_REVISION" | "AUTH_REQUIRED" | "VALIDATION" | "DATABASE";
  currentRevisionId?: string;
}

export type CapabilityShareState = {
  error?: string;
  capabilityUrl?: string;
  expiresAt?: string;
};

/**
 * Issues an emergency capability once and returns the raw value only to the
 * authenticated patient. The database receives its SHA-256 digest, never a
 * usable QR/link value. A 180-day emergency lifetime is the migration policy;
 * patients can issue a replacement before it expires.
 */
export async function createEmergencyCapability(
  _previous: CapabilityShareState | undefined,
  _formData: FormData,
): Promise<CapabilityShareState> {
  void _previous;
  void _formData;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const rawCapability = createRawCapability();
  // Stay below the database's 180-day hard ceiling to tolerate small
  // application/database clock differences without weakening the policy.
  const expiresAt = new Date(
    Date.now() + 179 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error } = await supabase.rpc("create_emergency_capability", {
    p_token_digest: digestCapability(rawCapability),
    p_purpose: "emergency",
    p_field_allowlist: EMERGENCY_FIELD_ALLOWLIST,
    p_expires_at: expiresAt,
    p_max_views: null,
  });
  if (error) {
    logError("Failed to issue emergency capability", error, {
      route: "/profile (action: createEmergencyCapability)",
    });
    return { error: "Could not create a new emergency QR. Please try again." };
  }

  revalidatePath("/profile");
  return {
    capabilityUrl: `${await getBaseUrl()}/card/c/${rawCapability}`,
    expiresAt,
  };
}

// --- Data export (Issue #12) ---

export type ProfileExport = {
  exportedAt: string;
  schemaVersion: 2;
  profile: Record<string, unknown>;
  recordRevisions: Record<string, unknown>[];
  disclosureSettings: Record<string, unknown>;
  consentEvents: Record<string, unknown>[];
  verificationRequests: Record<string, unknown>[];
  accessAuditSummaries: Record<string, unknown>[];
  storageObjects: {
    bucket: string;
    name: string;
    size: number | null;
    createdAt: string | null;
  }[];
  checksum: { algorithm: "sha256"; value: string };
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Returns the authenticated caller's own `profiles` row as a
 * structured export object. Relies on Supabase RLS — no service
 * role key is used, so a user can never fetch another user's row.
 */
export async function exportMyProfileData(): Promise<
  { data: ProfileExport } | { error: string }
> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "Not authenticated" };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (profileError || !profile) {
    return { error: "Could not load profile data" };
  }

  const [revisions, consents, requests, avatars] = await Promise.all([
    supabase
      .from("record_revisions")
      .select("*")
      .eq("user_id", user.id)
      .order("revision_number"),
    supabase
      .from("consent_events")
      .select("*")
      .eq("user_id", user.id)
      .order("occurred_at"),
    supabase
      .from("reattestation_requests")
      .select("*")
      .eq("user_id", user.id)
      .order("requested_at"),
    supabase.storage.from("avatars").list(user.id, { limit: 100 }),
  ]);
  if (revisions.error || consents.error || requests.error || avatars.error)
    return { error: "Could not assemble complete profile export" };
  const payload = {
    profile,
    recordRevisions: revisions.data,
    disclosureSettings: profile.disclosure_policy,
    consentEvents: consents.data,
    verificationRequests: requests.data,
    accessAuditSummaries: [],
    storageObjects: (avatars.data ?? []).map((object) => ({
      bucket: "avatars",
      name: object.name,
      size: object.metadata?.size ?? null,
      createdAt: object.created_at ?? null,
    })),
  };
  return {
    data: {
      exportedAt: new Date().toISOString(),
      schemaVersion: 2,
      ...payload,
      checksum: {
        algorithm: "sha256",
        value: createHash("sha256").update(stableJson(payload)).digest("hex"),
      },
    },
  };
}

/** Reads a repeated text-list field, dropping blank rows left by the +/- UI. */
function getTagList(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .map((value) => value.toString().trim())
    .filter((value) => value.length > 0);
}

/**
 * Emergency contacts are submitted as one JSON hidden input (see
 * EmergencyContactsField) rather than indexed field names. Blank rows (all
 * three sub-fields empty) are dropped the same way tag-list rows are.
 */
function getEmergencyContacts(formData: FormData): unknown[] {
  const raw = formData.get("emergencyContactsJson");
  if (typeof raw !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (contact) =>
        contact &&
        typeof contact === "object" &&
        [contact.name, contact.phone, contact.relationship].some(
          (value) => typeof value === "string" && value.trim().length > 0,
        ),
    );
  } catch {
    return [];
  }
}

export async function regenerateCardId(
  _prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  void formData;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: current } = await supabase
    .from("profiles")
    .select("card_public_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const newId = crypto.randomUUID();

  const { error } = await supabase
    .from("profiles")
    .update({ card_public_id: newId })
    .eq("user_id", user.id);

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/profile");
  if (current?.card_public_id)
    revalidatePath(`/card/${current.card_public_id}`);
  revalidatePath(`/card/${newId}`);
  return {};
}

export async function recordConsentChoice(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("AUTH_REQUIRED");
  const purpose = formData.get("purpose")?.toString() as ConsentPurpose;
  const action =
    formData.get("action") === "acknowledged" ? "acknowledged" : "withdrawn";
  const allowed: ConsentPurpose[] = [
    "emergency_public_disclosure",
    "offline_caching",
    "clinical_verification",
    "optional_analytics",
  ];
  if (!allowed.includes(purpose)) throw new Error("INVALID_CONSENT_PURPOSE");
  const { error } = await supabase.rpc("record_consent", {
    p_purpose: purpose,
    p_purpose_version: 1,
    p_action: action,
    p_idempotency_key: crypto.randomUUID(),
  });
  if (error) throw new Error("CONSENT_UPDATE_FAILED");
  const { data: profile } = await supabase
    .from("profiles")
    .select("card_public_id")
    .eq("user_id", user.id)
    .maybeSingle();
  revalidatePath("/profile");
  if (profile) revalidatePath(`/card/${profile.card_public_id}`);
}

export async function updateDisclosureChoices(
  formData: FormData,
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("AUTH_REQUIRED");
  const expected = formData.get("expectedRevisionId")?.toString();
  if (!expected) throw new Error("STALE_REVISION");
  const fields = { ...DEFAULT_DISCLOSURE_POLICY.fields };
  for (const field of Object.keys(fields)) {
    fields[field as keyof typeof fields] =
      formData.get(`field:${field}`) === "on";
  }
  fields.date_of_birth = false; // only derived age may ever be public
  const policy: DisclosurePolicy = { version: 1, fields };
  const { error } = await supabase.rpc("update_disclosure_policy", {
    p_expected_revision_id: expected,
    p_disclosure_policy: policy,
  });
  if (error)
    throw new Error(
      error.code === "40001" ? "STALE_REVISION" : "DISCLOSURE_UPDATE_FAILED",
    );
  const { data: profile } = await supabase
    .from("profiles")
    .select("card_public_id")
    .eq("user_id", user.id)
    .single();
  revalidatePath("/profile");
  if (profile) revalidatePath(`/card/${profile.card_public_id}`);
}

/**
 * Fills in defaults for fields the UI doesn't expose yet (grown field group
 * by field group across several commits) from the existing row, so a save
 * never silently wipes data the current form doesn't render a control for.
 */
function toFormDefaults(existing: ProfileRow | null) {
  return {
    name: existing?.name ?? "",
    dateOfBirth: existing?.date_of_birth ?? "",
    language: existing?.language ?? "",
    photoUrl: existing?.photo_url ?? "",
    bloodGroup: existing?.blood_group ?? ("unknown" as const),
    genotype: existing?.genotype ?? ("unknown" as const),
    allergies: existing?.allergies ?? [],
    medications: existing?.medications ?? [],
    chronicConditions: existing?.chronic_conditions ?? [],
    emergencyContacts: existing?.emergency_contacts ?? [],
  };
}

export async function upsertProfile(
  _prevState: ProfileFormState | undefined,
  formData: FormData,
): Promise<ProfileFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  // Optimistic concurrency only applies to updating a row that already
  // exists — a brand-new profile (existing === null, e.g. right after
  // signup) has no prior version to conflict with, and ProfileForm only
  // renders the expectedUpdatedAt hidden input when a profile is passed in,
  // so requiring the token unconditionally here made every first-ever save
  // fail with "Missing concurrency token."
  if (existing) {
    const expectedRevisionId = formData.get("expectedRevisionId")?.toString();
    if (
      typeof expectedRevisionId !== "string" ||
      expectedRevisionId.length === 0
    ) {
      return { error: "Missing concurrency token. Please reload the page." };
    }

    if (existing.current_revision_id !== expectedRevisionId) {
      return {
        code: "STALE_REVISION",
        currentRevisionId: existing.current_revision_id ?? undefined,
        error:
          "This profile was updated elsewhere since you loaded this page. Reload and reapply your changes before saving.",
      };
    }
  }

  const defaults = toFormDefaults(existing);

  const parsed = profileFormSchema.safeParse({
    ...defaults,
    name: formData.get("name"),
    dateOfBirth: formData.get("dateOfBirth") || undefined,
    language: formData.get("language") || undefined,
    photoUrl: formData.get("photoUrl") || undefined,
    bloodGroup: formData.get("bloodGroup") || undefined,
    genotype: formData.get("genotype") || undefined,
    allergies: getTagList(formData, "allergies"),
    medications: getTagList(formData, "medications"),
    chronicConditions: getTagList(formData, "chronicConditions"),
    emergencyContacts: getEmergencyContacts(formData),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    parsed.error.issues.forEach((issue) => {
      const field = issue.path[0];
      if (typeof field === "string" && !fieldErrors[field]) {
        fieldErrors[field] = issue.message;
      }
    });
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      errors: fieldErrors,
    };
  }

  const emergencyData = normalizeEmergencyRecord({
    name: parsed.data.name,
    date_of_birth: parsed.data.dateOfBirth || null,
    language: parsed.data.language || null,
    photo_url: parsed.data.photoUrl || null,
    blood_group: parsed.data.bloodGroup,
    genotype: parsed.data.genotype,
    allergies: parsed.data.allergies,
    medications: parsed.data.medications,
    chronic_conditions: parsed.data.chronicConditions,
    emergency_contacts: parsed.data.emergencyContacts,
  });

  let secret: string;
  try {
    secret = await ensureRecordSecret(user.id);
  } catch (secretError) {
    logError("Failed to ensure record secret", secretError, {
      route: "/profile (action: upsertProfile)",
    });
    return {
      code: "DATABASE",
      error: "Your record could not be saved safely. Please try again.",
    };
  }

  const commitment = computeRevisionCommitment(emergencyData, secret);
  const disclosurePolicy =
    existing?.disclosure_policy ?? DEFAULT_DISCLOSURE_POLICY;
  const { error } = await supabase.rpc("save_record_revision", {
    p_expected_revision_id: existing?.current_revision_id ?? null,
    p_emergency_data: emergencyData,
    p_provenance: {},
    p_disclosure_policy: disclosurePolicy,
    p_commitment: commitment,
  });

  if (error) {
    if (error.message.includes("STALE_REVISION") || error.code === "40001") {
      return {
        code: "STALE_REVISION",
        error:
          "This record has a newer revision. Reload before merging your changes.",
      };
    }
    logError("Failed to upsert profile in database", error, {
      route: "/profile (action: upsertProfile)",
    });
    return {
      code: "DATABASE",
      error: "Your record could not be saved. Please try again.",
    };
  }

  const { data: updatedProfile } = await supabase
    .from("profiles")
    .select("card_public_id")
    .eq("user_id", user.id)
    .maybeSingle();

  revalidatePath("/profile");
  if (updatedProfile?.card_public_id) {
    revalidatePath(`/card/${updatedProfile.card_public_id}`);
  }
  return { success: true };
}

export async function deleteAccount(
  _prevState: ProfileFormState | undefined,
  formData: FormData,
): Promise<ProfileFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const confirm = formData.get("confirm")?.toString().trim();
  if (confirm !== "DELETE") {
    return { error: "Type DELETE to confirm." };
  }

  const admin = createAdminClient();

  try {
    await deleteAccountAndData(admin, user.id);
  } catch (error) {
    logError("Failed to delete account data", error, {
      route: "/profile (action: deleteAccount)",
    });
    return {
      error:
        error instanceof Error ? error.message : "Failed to delete account.",
    };
  }

  await supabase.auth.signOut();
  redirect("/");
}

/**
 * Raises a "please re-verify my card" request for the caller's own
 * currently-computed record hash (recomputed fresh here, never trusted
 * from client input, so a stale/forged hash can't be queued). Minimal,
 * queue-only implementation — actually re-attesting is a CHW-facing tool
 * (lafiya-verifier) out of scope for this app; see
 * supabase/migrations/20260729120200_reattestation_requests.sql.
 *
 * Idempotent: a second request for the same (user, hash) while one is
 * still pending is treated as success rather than an error (unique
 * partial index on the table enforces this at the DB level).
 */
export async function requestReattestation(
  _prevState: ProfileFormState | undefined,
  formData: FormData,
): Promise<ProfileFormState> {
  void formData;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) {
    return { error: "No profile found." };
  }

  if (!profile.current_revision_id)
    return { error: "No current revision found." };
  const { error } = await supabase.rpc("request_revision_verification", {
    p_expected_revision_id: profile.current_revision_id,
  });

  if (error) {
    logError("Failed to create reattestation request", error, {
      route: "/profile (action: requestReattestation)",
    });
    if (error.code === "40001")
      return {
        code: "STALE_REVISION",
        error: "This record changed. Reload before requesting verification.",
      };
    if (error.message.includes("CONSENT_REQUIRED"))
      return {
        error: "Allow clinical verification in Privacy and consent first.",
      };
    return { error: "Could not request verification. Please try again." };
  }

  revalidatePath("/profile");
  return { success: true };
}

// --- Profile secret repair (Issue #149) ---

export type RepairSecretResult =
  | { status: "already_ok" }
  | { status: "repaired" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "error"; error: string };

/**
 * Repairs a profile whose record secret was not provisioned (e.g.
 * ensureRecordSecret failed transiently after the profile save
 * succeeded). Idempotent: if the secret already exists the result is
 * "already_ok". Safe under concurrency: the underlying
 * ensureRecordSecret uses upsert with ignoreDuplicates so a race
 * between two concurrent repair requests cannot create duplicate rows
 * or rotate an existing secret.
 *
 * Never returns the raw secret — the result is purely a status
 * descriptor so it can safely be sent to the client.
 */
export async function repairProfileSecret(): Promise<RepairSecretResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { status: "unauthorized" };
  }

  // Resolve the authenticated user's profile. RLS (eq(user_id)) ensures
  // a user can never reference another user's profile.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { status: "not_found" };
  }

  // Check whether a secret already exists — idempotent fast path.
  const exists = await secretExistsByUserId(user.id);
  if (exists) {
    return { status: "already_ok" };
  }

  // Secret is missing — provision it via the existing admin-only helper.
  // ensureRecordSecret uses upsert with ignoreDuplicates so a concurrent
  // request that created the secret between our check and this write will
  // be safely absorbed.
  try {
    await ensureRecordSecret(user.id);
  } catch (err) {
    logError("Failed to repair profile secret", err, {
      route: "/profile (action: repairProfileSecret)",
      userId: user.id,
    });
    return {
      status: "error",
      error: "Could not provision verification secret. Please try again later.",
    };
  }

  revalidatePath("/profile");
  return { status: "repaired" };
}
