"use server";

/**
 * Issue #531: Delegated caregiver server actions.
 *
 * All writes go through Postgres security-definer RPCs which call
 * can_manage_profile() to gate access and write to guardian_audit_log.
 * Server actions here only:
 *   1. Authenticate the caller.
 *   2. Validate/normalise input.
 *   3. Call the appropriate RPC.
 *   4. Revalidate the profile path.
 *
 * profile_id (dependant UUID) is always taken from form data — never
 * derived from auth.uid() alone — so that the RPC can authorize
 * guardians managing another user's data.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { hasReachedMajority } from "@/lib/account/guardianHandover";
import {
  CURRENT_POLICY_VERSION,
  GUARDIAN_ASSURANCE_METHODS,
  decideMinorCardActivation,
  type GuardianConsentRecord,
} from "@/lib/consent";
import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";
import type { DependantRow } from "@/lib/supabase/types";
import { formatZodError } from "@/lib/validation/zod";

// Minimal schema reused for both create and update
const dependantSchema = z.object({
  name: z.string().min(1, "Name is required").max(200, "Name is too long"),
  dateOfBirth: z.string().optional(),
  language: z.string().optional(),
  bloodGroup: z.string().optional(),
  genotype: z.string().optional(),
});

export type DependantFormState = {
  error?: string;
  errors?: Record<string, string>;
  success?: boolean;
  dependant?: DependantRow;
};

// ---- Create dependant ----

export async function createDependant(
  _prev: DependantFormState | undefined,
  formData: FormData,
): Promise<DependantFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const parsed = dependantSchema.safeParse({
    name: formData.get("name"),
    dateOfBirth: formData.get("dateOfBirth") || undefined,
    language: formData.get("language") || undefined,
    bloodGroup: formData.get("bloodGroup") || undefined,
    genotype: formData.get("genotype") || undefined,
  });

  if (!parsed.success) return formatZodError(parsed.error);

  const { data, error } = await supabase
    .rpc("create_dependant", {
      p_name: parsed.data.name,
      p_date_of_birth: parsed.data.dateOfBirth ?? null,
      p_language: parsed.data.language ?? null,
      p_blood_group: parsed.data.bloodGroup ?? null,
      p_genotype: parsed.data.genotype ?? null,
    });

  if (error) {
    if (error.message.includes("MAX_DEPENDANTS_REACHED")) {
      return { error: "You can manage at most 5 dependant profiles." };
    }
    logError("Failed to create dependant", error, {
      route: "/profile (guardian-actions: createDependant)",
    });
    return { error: "Could not create dependant profile. Please try again." };
  }

  revalidatePath("/profile");
  return { success: true, dependant: data as unknown as DependantRow };
}

// ---- Update dependant ----

export async function updateDependant(
  _prev: DependantFormState | undefined,
  formData: FormData,
): Promise<DependantFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const dependantId = formData.get("dependantId");
  if (typeof dependantId !== "string" || !dependantId) {
    return { error: "Missing dependant ID." };
  }

  const parsed = dependantSchema.safeParse({
    name: formData.get("name"),
    dateOfBirth: formData.get("dateOfBirth") || undefined,
    language: formData.get("language") || undefined,
    bloodGroup: formData.get("bloodGroup") || undefined,
    genotype: formData.get("genotype") || undefined,
  });

  if (!parsed.success) return formatZodError(parsed.error);

  const { data, error } = await supabase.rpc("update_dependant", {
    p_dependant_id: dependantId,
    p_name: parsed.data.name,
    p_date_of_birth: parsed.data.dateOfBirth ?? null,
    p_language: parsed.data.language ?? null,
    p_blood_group: parsed.data.bloodGroup ?? null,
    p_genotype: parsed.data.genotype ?? null,
  });

  if (error) {
    if (error.message.includes("UNAUTHORIZED")) {
      return { error: "You are not authorised to edit this profile." };
    }
    logError("Failed to update dependant", error, {
      route: "/profile (guardian-actions: updateDependant)",
    });
    return { error: "Could not save changes. Please try again." };
  }

  revalidatePath("/profile");
  return { success: true, dependant: data as unknown as DependantRow };
}

// ---- Delete dependant ----

export type DeleteDependantState = {
  error?: string;
  success?: boolean;
};

export async function deleteDependant(
  _prev: DeleteDependantState | undefined,
  formData: FormData,
): Promise<DeleteDependantState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const dependantId = formData.get("dependantId");
  if (typeof dependantId !== "string" || !dependantId) {
    return { error: "Missing dependant ID." };
  }

  const confirm = formData.get("confirm")?.toString().trim();
  if (confirm !== "DELETE") {
    return { error: "Type DELETE to confirm removal of this dependant profile." };
  }

  const { error } = await supabase.rpc("delete_dependant", {
    p_dependant_id: dependantId,
  });

  if (error) {
    if (error.message.includes("UNAUTHORIZED")) {
      return { error: "You are not authorised to delete this profile." };
    }
    logError("Failed to delete dependant", error, {
      route: "/profile (guardian-actions: deleteDependant)",
    });
    return { error: "Could not remove this profile. Please try again." };
  }

  revalidatePath("/profile");
  return { success: true };
}

// ---- Guardian consent for minors (issue #871) ----

const guardianConsentSchema = z.object({
  dependantId: z.string().uuid("Missing dependant ID."),
  method: z.enum(GUARDIAN_ASSURANCE_METHODS),
  // Reference to evidence held by the verifier (e.g. CHW visit or facility
  // record number). Documents themselves are never stored in the ledger.
  evidenceRef: z.string().trim().max(200).optional(),
});

export type GuardianConsentState = { error?: string; success?: boolean };

export async function requestGuardianConsent(
  _prev: GuardianConsentState | undefined,
  formData: FormData,
): Promise<GuardianConsentState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const parsed = guardianConsentSchema.safeParse({
    dependantId: formData.get("dependantId"),
    method: formData.get("method"),
    evidenceRef: formData.get("evidenceRef") || undefined,
  });
  if (!parsed.success) return formatZodError(parsed.error);

  const { error } = await supabase.rpc("record_guardian_consent", {
    p_dependant_id: parsed.data.dependantId,
    p_method: parsed.data.method,
    p_evidence_ref: parsed.data.evidenceRef ?? null,
    p_policy_version: CURRENT_POLICY_VERSION,
  });
  if (error) {
    if (error.message.includes("UNAUTHORIZED")) {
      return { error: "You are not authorised to manage this profile." };
    }
    logError("Failed to record guardian consent", error, {
      route: "/profile (guardian-actions: requestGuardianConsent)",
    });
    return { error: "Could not record consent. Please try again." };
  }

  revalidatePath("/profile");
  return { success: true };
}

export type CardVisibilityState = { error?: string; success?: boolean };

/**
 * Makes a dependant's card public/private. A minor's card cannot be made
 * public without verified consent from the current guardian; the database
 * RPC enforces the same rule.
 */
export async function setDependantCardPublic(
  _prev: CardVisibilityState | undefined,
  formData: FormData,
): Promise<CardVisibilityState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const dependantId = formData.get("dependantId");
  if (typeof dependantId !== "string" || !dependantId) {
    return { error: "Missing dependant ID." };
  }
  const makePublic = formData.get("public") === "true";

  if (makePublic) {
    const { data: dependant } = await supabase
      .from("dependants")
      .select("date_of_birth")
      .eq("id", dependantId)
      .maybeSingle();
    const { data: consents } = await supabase
      .from("guardian_consents")
      .select("*")
      .eq("dependant_id", dependantId);
    const dob = dependant?.date_of_birth;
    const decision = decideMinorCardActivation({
      isMinor: !dob || !hasReachedMajority(dob, new Date()),
      currentGuardianId: user.id,
      consents: (consents ?? []) as GuardianConsentRecord[],
    });
    if (!decision.allowed) {
      return {
        error:
          decision.reason === "consent_pending"
            ? "Guardian consent is awaiting verification. The card can be made public once it is verified."
            : decision.reason === "majority_reconfirm"
              ? "This dependant has reached the age of majority and must make their own card public."
              : "A verified guardian consent is required before a child's card can be made public.",
      };
    }
  }

  const { error } = await supabase.rpc("set_dependant_card_public", {
    p_dependant_id: dependantId,
    p_public: makePublic,
    p_policy_version: CURRENT_POLICY_VERSION,
  });
  if (error) {
    if (error.message.includes("MAJORITY_RECONFIRM_REQUIRED")) {
      return {
        error:
          "This dependant has reached the age of majority and must make their own card public.",
      };
    }
    if (error.message.includes("GUARDIAN_CONSENT_REQUIRED")) {
      return {
        error:
          "A verified guardian consent is required before a child's card can be made public.",
      };
    }
    if (error.message.includes("UNAUTHORIZED")) {
      return { error: "You are not authorised to manage this profile." };
    }
    logError("Failed to change dependant card visibility", error, {
      route: "/profile (guardian-actions: setDependantCardPublic)",
    });
    return { error: "Could not update card visibility. Please try again." };
  }

  revalidatePath("/profile");
  return { success: true };
}
