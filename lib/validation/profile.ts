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

// Structured medication entry (issue #605). Mirrors the structured allergies
// pattern: a curated list with a free-text fallback so existing entries migrate
// losslessly and unusual drugs can still be captured.
export const MEDICATION_ROUTES = [
  "Oral",
  "Sublingual",
  "Topical",
  "Inhalation",
  "Injection",
  "Intravenous",
  "Intramuscular",
  "Subcutaneous",
  "Rectal",
  "Ocular",
  "Otic",
  "Nasal",
  "Other",
] as const;

export const MEDICATION_FREQUENCIES = [
  "Once daily",
  "Twice daily",
  "Three times daily",
  "Four times daily",
  "Every 4 hours",
  "Every 6 hours",
  "Every 8 hours",
  "Every 12 hours",
  "Weekly",
  "As needed",
  "Other",
] as const;

// Curated, Nigerian EML-based medication list. Names are the generic names used
// on the Nigerian Essential Medicines List; the free-text fallback covers
// anything not listed here.
export const COMMON_MEDICATIONS = [
  "Paracetamol",
  "Ibuprofen",
  "Diclofenac",
  "Aspirin",
  "Amoxicillin",
  "Amoxicillin/Clavulanate",
  "Ampicillin",
  "Ceftriaxone",
  "Ciprofloxacin",
  "Erythromycin",
  "Metronidazole",
  "Cotrimoxazole",
  "Doxycycline",
  "Artemether/Lumefantrine",
  "Artesunate",
  "Chloroquine",
  "Albendazole",
  "Mebendazole",
  "Metformin",
  "Glibenclamide",
  "Insulin",
  "Amlodipine",
  "Nifedipine",
  "Lisinopril",
  "Enalapril",
  "Losartan",
  "Hydrochlorothiazide",
  "Furosemide",
  "Atenolol",
  "Propranolol",
  "Methyldopa",
  "Atorvastatin",
  "Simvastatin",
  "Warfarin",
  "Heparin",
  "Enoxaparin",
  "Clopidogrel",
  "Carbamazepine",
  "Phenytoin",
  "Sodium Valproate",
  "Levetiracetam",
  "Phenobarbitone",
  "Salbutamol",
  "Beclomethasone",
  "Prednisolone",
  "Dexamethasone",
  "Levothyroxine",
  "Carbimazole",
  "Ferrous Sulphate",
  "Folic Acid",
  "Vitamin C",
  "Omeprazole",
  "Ranitidine",
  "Cetirizine",
  "Chlorpheniramine",
  "Tramadol",
  "Morphine",
  "Diazepam",
  "Amitriptyline",
  "Fluoxetine",
  "Haloperidol",
  "Risperidone",
  "Isoniazid",
  "Rifampicin",
  "Pyrazinamide",
  "Ethambutol",
  "Tenofovir/Lamivudine/Dolutegravir",
  "Nevirapine",
  "Zidovudine",
] as const;

// Critical medications change emergency management immediately (insulin,
// anticoagulants, anti-epileptics, and similar). Matched case-insensitively
// against the medication name so curated and free-text entries both flag.
export const CRITICAL_MEDICATIONS = [
  "Insulin",
  "Warfarin",
  "Heparin",
  "Enoxaparin",
  "Clopidogrel",
  "Carbamazepine",
  "Phenytoin",
  "Sodium Valproate",
  "Levetiracetam",
  "Phenobarbitone",
  "Levothyroxine",
  "Carbimazole",
  "Morphine",
  "Digoxin",
  "Methotrexate",
  "Prednisolone",
  "Dexamethasone",
] as const;

/**
 * Returns true when a medication name matches the critical-medication list.
 * Case-insensitive and tolerant of surrounding whitespace so free-text entries
 * (e.g. "warfarin 5mg") still flag on the card.
 */
export function isCriticalMedication(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return CRITICAL_MEDICATIONS.some((critical) => {
    const target = critical.toLowerCase();
    return normalized === target || normalized.includes(target);
  });
}

export const medicationSchema = z.object({
  name: z.string().trim().min(1, "Medication name is required").max(200),
  strength: z.string().trim().max(100).optional(),
  dose: z.string().trim().max(100).optional(),
  route: z
    .string()
    .trim()
    .max(50)
    .refine(
      (val) =>
        !val ||
        MEDICATION_ROUTES.includes(val as typeof MEDICATION_ROUTES[number]),
      "Please select a valid route or enter a custom value",
    )
    .optional(),
  frequency: z
    .string()
    .trim()
    .max(50)
    .refine(
      (val) =>
        !val ||
        MEDICATION_FREQUENCIES.includes(
          val as typeof MEDICATION_FREQUENCIES[number],
        ),
      "Please select a valid frequency or enter a custom value",
    )
    .optional(),
  critical: z.boolean().optional(),
});

export type Medication = z.infer<typeof medicationSchema>;

/**
 * Losslessly migrates a legacy free-text medication entry into the structured
 * shape. The original text is preserved verbatim as the name so no clinical
 * information is dropped, and the critical flag is derived from the name.
 */
export function migrateMedicationEntry(
  entry: string | Medication,
): Medication {
  if (typeof entry !== "string") {
    return {
      ...entry,
      critical: entry.critical ?? isCriticalMedication(entry.name),
    };
  }
  const name = entry.trim();
  return { name, critical: isCriticalMedication(name) };
}

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
  allergies: z.array(z.string().trim().min(1).max(200)).max(20),
  medications: z.array(medicationSchema).max(20),
  chronicConditions: z.array(z.string().trim().min(1).max(200)).max(20),
  emergencyContacts: z
    .array(emergencyContactSchema)
    .max(3, "Up to 3 emergency contacts"),
});

export type ProfileFormValues = z.infer<typeof profileFormSchema>;
