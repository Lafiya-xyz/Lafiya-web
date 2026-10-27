"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { CONTACT_PREFERENCES } from "@/lib/chw-protocol/visit-requests";
import { createClient } from "@/lib/supabase/server";

export type VisitActionState =
  { error?: string; success?: boolean } | undefined;

const requestSchema = z.object({
  lga: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .pipe(z.string().min(1).max(100)),
  preferredLanguage: z.string().trim().max(20).optional(),
  contactPreference: z.enum(CONTACT_PREFERENCES),
  contactPhone: z.string().trim().max(32).optional(),
  consent: z.literal("on").optional(),
});

/** Issue #765: patient asks for a verification visit. */
export async function requestVerificationVisit(
  _prev: VisitActionState,
  formData: FormData,
): Promise<VisitActionState> {
  const parsed = requestSchema.safeParse({
    lga: formData.get("lga"),
    preferredLanguage: formData.get("preferredLanguage") || undefined,
    contactPreference: formData.get("contactPreference"),
    contactPhone: formData.get("contactPhone") || undefined,
    consent: formData.get("consent") || undefined,
  });
  if (!parsed.success)
    return { error: "Please enter your LGA and contact preference." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Please sign in again." };

  const { error } = await (supabase as any)
    .from("verification_requests")
    .insert({
      patient_id: user.id,
      lga: parsed.data.lga,
      preferred_language: parsed.data.preferredLanguage ?? null,
      contact_preference: parsed.data.contactPreference,
      contact_consent: parsed.data.consent === "on",
      contact_phone: parsed.data.contactPhone ?? null,
    });
  if (error)
    return {
      error: "Could not send your request. You may already have one open.",
    };

  revalidatePath("/profile");
  return { success: true };
}

export async function setVisitContactConsent(
  requestId: string,
  consent: boolean,
) {
  const supabase = await createClient();
  await (supabase as any).rpc("set_verification_contact_consent", {
    p_request_id: requestId,
    p_consent: consent,
  });
  revalidatePath("/profile");
}

export async function cancelVerificationVisit(requestId: string) {
  const supabase = await createClient();
  await (supabase as any).rpc("cancel_my_verification_request", {
    p_request_id: requestId,
  });
  revalidatePath("/profile");
}
