import { z } from "zod";
import { isValidPhoneNumber } from "libphonenumber-js";

export { formatZodError } from "./zod";

export const BLOOD_GROUPS = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
  "unknown",
] as const;

export const GENOTYPES = ["AA", "AS", "SS", "SC", "AC", "unknown"] as const;

// Common relationship types for emergency contacts
export const RELATIONSHIP_TYPES = [
  "Spouse",
  "Parent",
  "Child",
  "Sibling",
  "Grandparent",
  "Grandchild",
  "Aunt",
  "Uncle",
  "Cousin",
  "In-law",
  "Friend",
  "Caregiver",
  "Healthcare Provider",
  "Other",
] as const;

// Structured allergy taxonomy. Severity and criticality are distinct: severity
// describes the reaction intensity, criticality the risk to life if re-exposed.
// Ordering here is the canonical sort order used by the emergency card.
export const ALLERGY_SEVERITIES = [
  "mild",
  "moderate",
  "severe",
  "life-threatening",
] as const;

export const ALLERGY_CRITICALITIES = [
  "low",
  "high",
  "unable-to-assess",
] as const;

export const ALLERGY_REACTIONS = [
  "anaphylaxis",
  "angioedema",
  "urticaria",
  "rash",
  "bronchospasm",
  "gastrointestinal",
  "other",
] as const;

export const allergySchema = z.object({
  // Coded substance (SNOMED CT / RxNorm) when a terminology match exists.
  coded: z
    .object({
      system: z.string().trim().min(1).max(200),
      code: z.string().trim().min(1).max(100),
      display: z.string().trim().min(1).max(200),
    })
    .nullable()
    .default(null),
  // Free-text fallback; required when no code is present so nothing is lost.
  substanceText: z.string().trim().min(1).max(200),
  reaction: z.enum(ALLERGY_REACTIONS).nullable().default(null),
  severity: z.enum(ALLERGY_SEVERITIES).nullable().default(null),
  criticality: z.enum(ALLERGY_CRITICALITIES).default("unable-to-assess"),
});

export type Allergy = z.infer<typeof allergySchema>;

export const emergencyContactSchema = z.object({
  name: z.string().trim().min(1, "Contact name is required").max(100),
  phone: z
    .string()
    .trim()
    .min(1, "Contact phone is required")
    .max(30)
    .refine((val) => isValidPhoneNumber(val, "NG"), {
      message: "This doesn't look like a valid phone number",
    }),
  relationship: z
    .string()
    .trim()
    .min(1, "Relationship is required")
    .max(50)
    .refine(
      (val) =>
        RELATIONSHIP_TYPES.includes(val as typeof RELATIONSHIP_TYPES[number]) ||
        val.length > 0,
      "Please select a relationship type or enter a custom value",
    ),
});

/**
 * Mirrors supabase/migrations/*_profiles_table.sql. Field lists here are
 * bounded (max array lengths) to match the emergency_contacts_is_bounded_array
 * check constraint and to keep the emergency page scannable in a crisis.
 */
export const profileFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  dateOfBirth: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || !Number.isNaN(Date.parse(value)),
      "Enter a valid date",
    ),
  language: z.string().trim().max(100).optional(),
  photoUrl: z.string().trim().max(2048).optional(),
  bloodGroup: z.enum(BLOOD_GROUPS, {
    error: `Blood group must be one of: ${BLOOD_GROUPS.join(", ")}`,
  }),
  genotype: z.enum(GENOTYPES, {
    error: `Genotype must be one of: ${GENOTYPES.join(", ")}`,
  }),
  allergies: z.array(allergySchema).max(20),
  medications: z.array(z.string().trim().min(1).max(200)).max(20),
  chronicConditions: z.array(z.string().trim().min(1).max(200)).max(20),
  emergencyContacts: z
    .array(emergencyContactSchema)
    .max(3, "Up to 3 emergency contacts"),
});

export type ProfileFormValues = z.infer<typeof profileFormSchema>;
