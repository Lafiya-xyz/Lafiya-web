"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { deleteAccountAndData } from "@/lib/account/deleteAccount";
import { computeRecordHash } from "@/lib/attestation/recordHash";
import {
  ensureRecordSecret,
  getSecretByUserId,
} from "@/lib/attestation/recordSecret";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ConsentLogRow, ProfileRow } from "@/lib/supabase/types";
import { profileFormSchema } from "@/lib/validation/profile";

import { logError } from "@/lib/logging/logger";

export interface ProfileFormState {
  error?: string;
  errors?: Record<string, string>;
  success?: boolean;
}

// --- Data export (Issue #12) ---

export type ProfileExport = {
  exportedAt: string;
  schemaVersion: 2;
  profile: Record<string, unknown>;
  consentLogs: ConsentLogRow[];
};

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

  const { data: consentLogs, error: consentError } = await supabase
    .from("consent_logs")
    .select("*")
    .eq("user_id", user.id)
    .order("accepted_at", { ascending: true });

  if (consentError) {
    return { error: "Could not load consent data" };
  }

  return {
    data: {
      exportedAt: new Date().toISOString(),
      schemaVersion: 2,
      profile,
      consentLogs: consentLogs ?? [],
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

  const newId = crypto.randomUUID();

  const { error } = await supabase
    .from("profiles")
    .update({ card_public_id: newId })
    .eq("user_id", user.id);

  if (error) {
    return { error: error.message };
  }

  revalidatePath("/profile");
  return {};
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

  const { data: existing, error: selectError } = await supabase
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
    const expectedUpdatedAt = formData.get("expectedUpdatedAt")?.toString();
    if (
      typeof expectedUpdatedAt !== "string" ||
      expectedUpdatedAt.length === 0
    ) {
      return { error: "Missing concurrency token. Please reload the page." };
    }

    if (existing.updated_at !== expectedUpdatedAt) {
      return {
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

  const { error } = await supabase.from("profiles").upsert({
    user_id: user.id,
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

  if (error) {
    logError("Failed to upsert profile in database", error, {
      route: "/profile (action: upsertProfile)",
      userId: user.id,
    });
    return { error: error.message };
  }

  // Ensures this profile has a record_secret (the HMAC pepper backing
  // computeRecordHash — see lib/attestation/recordSecret.ts) without ever
  // regenerating an existing one, which would silently invalidate any past
  // attestation for this patient. A failure here is logged, not fatal to
  // the save itself — the profile save has already succeeded, and a
  // missing secret degrades to "verification unavailable" rather than
  // losing data.
  try {
    await ensureRecordSecret(user.id);
  } catch (secretError) {
    logError("Failed to ensure record secret", secretError, {
      route: "/profile (action: upsertProfile)",
      userId: user.id,
    });
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
      userId: user.id,
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

  const secret = await getSecretByUserId(user.id);
  if (!secret) {
    return { error: "Could not compute your record hash. Please try again." };
  }

  const recordHash = computeRecordHash(profile, secret);

  const { error } = await supabase
    .from("reattestation_requests")
    .insert({ user_id: user.id, record_hash: recordHash });

  // 23505 = unique_violation: a pending request for this exact hash already
  // exists — that's the desired end state, not a failure.
  if (error && error.code !== "23505") {
    logError("Failed to create reattestation request", error, {
      route: "/profile (action: requestReattestation)",
      userId: user.id,
    });
    return { error: error.message };
  }

  revalidatePath("/profile");
  return { success: true };
}
