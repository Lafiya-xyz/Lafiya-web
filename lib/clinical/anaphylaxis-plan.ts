import { z } from "zod";

/**
 * Issue #923: structured anaphylaxis action plan.
 *
 * Stored alongside the structured allergy entries (see
 * lib/validation/profile.ts) so a high-criticality allergy can carry the
 * auto-injector details a responder needs in the first minute: device type,
 * dose, where the device is carried, prior events and who authored the plan.
 *
 * Dose validation is weight-based for children: the licensed adrenaline
 * auto-injector strengths are 0.15 mg (7.5–15 kg / 15–30 kg depending on
 * label) and 0.3 mg (≥ 30 kg). We validate against the conservative
 * paediatric bands below and never invent a dose — an out-of-band dose is a
 * validation error the patient must resolve with their clinician.
 */

export const AUTO_INJECTOR_TYPES = [
  "EpiPen Jr 0.15 mg",
  "EpiPen 0.3 mg",
  "Jext 0.15 mg",
  "Jext 0.3 mg",
  "Emerade 0.15 mg",
  "Emerade 0.3 mg",
  "Emerade 0.5 mg",
  "Anapen 0.15 mg",
  "Anapen 0.3 mg",
  "Anapen 0.5 mg",
  "Other",
] as const;

export const AUTO_INJECTOR_DOSES_MG = [0.15, 0.3, 0.5] as const;

export const AUTO_INJECTOR_CARRIED_LOCATIONS = [
  "On person",
  "School bag",
  "Handbag",
  "Home — kitchen",
  "Home — bedroom",
  "Vehicle",
  "With a caregiver",
  "Other",
] as const;

/** Weight bands (kg) for each licensed paediatric/adult dose. */
export const DOSE_WEIGHT_BANDS: Record<
  (typeof AUTO_INJECTOR_DOSES_MG)[number],
  { minKg: number; maxKg: number | null }
> = {
  0.15: { minKg: 7.5, maxKg: 30 },
  0.3: { minKg: 15, maxKg: null },
  0.5: { minKg: 30, maxKg: null },
};

export type AutoInjectorDose = (typeof AUTO_INJECTOR_DOSES_MG)[number];

/**
 * Returns an error message when `doseMg` is outside the licensed weight band
 * for `weightKg`, or null when the pair is acceptable. Weight is optional:
 * without it we cannot check the band and accept the dose as recorded.
 */
export function validateDoseForWeight(
  doseMg: number,
  weightKg: number | null | undefined,
): string | null {
  if (!(doseMg in DOSE_WEIGHT_BANDS)) {
    return `Dose must be one of ${AUTO_INJECTOR_DOSES_MG.join(", ")} mg`;
  }
  if (weightKg === null || weightKg === undefined) return null;
  const band = DOSE_WEIGHT_BANDS[doseMg as AutoInjectorDose];
  if (weightKg < band.minKg) {
    return `${doseMg} mg is not licensed below ${band.minKg} kg — confirm the dose with the prescriber`;
  }
  if (band.maxKg !== null && weightKg > band.maxKg) {
    return `${doseMg} mg is not licensed above ${band.maxKg} kg — confirm the dose with the prescriber`;
  }
  return null;
}

export const anaphylaxisPlanSchema = z
  .object({
    autoInjectorType: z.enum(AUTO_INJECTOR_TYPES),
    /** Free-text device name, required when the type is "Other". */
    autoInjectorOther: z.string().trim().max(100).nullable().default(null),
    doseMg: z
      .number()
      .refine(
        (value) =>
          (AUTO_INJECTOR_DOSES_MG as readonly number[]).includes(value),
        `Dose must be one of ${AUTO_INJECTOR_DOSES_MG.join(", ")} mg`,
      ),
    /** Patient weight in kg, used for paediatric dose validation. */
    weightKg: z.number().positive().max(300).nullable().default(null),
    carriedAt: z.enum(AUTO_INJECTOR_CARRIED_LOCATIONS),
    carriedAtOther: z.string().trim().max(100).nullable().default(null),
    /** Number of prior anaphylaxis events, if known. */
    priorEvents: z.number().int().min(0).max(100).nullable().default(null),
    /** Free-text summary of the most recent event. */
    priorEventSummary: z.string().trim().max(500).nullable().default(null),
    /** Who authored the plan (clinician name / role). */
    planAuthor: z.string().trim().min(1).max(200),
    /** ISO date the plan was last reviewed. */
    reviewedOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
      .nullable()
      .default(null),
  })
  .superRefine((plan, ctx) => {
    if (plan.autoInjectorType === "Other" && !plan.autoInjectorOther) {
      ctx.addIssue({
        code: "custom",
        path: ["autoInjectorOther"],
        message: "Name the auto-injector",
      });
    }
    if (plan.carriedAt === "Other" && !plan.carriedAtOther) {
      ctx.addIssue({
        code: "custom",
        path: ["carriedAtOther"],
        message: "Say where the auto-injector is carried",
      });
    }
    const doseError = validateDoseForWeight(plan.doseMg, plan.weightKg);
    if (doseError) {
      ctx.addIssue({ code: "custom", path: ["doseMg"], message: doseError });
    }
  });

export type AnaphylaxisPlan = z.infer<typeof anaphylaxisPlanSchema>;

/** Human-readable device label, falling back to the free-text name. */
export function autoInjectorLabel(plan: AnaphylaxisPlan): string {
  return plan.autoInjectorType === "Other"
    ? (plan.autoInjectorOther ?? "Auto-injector")
    : plan.autoInjectorType;
}

/** Human-readable carry location, falling back to the free-text value. */
export function carriedAtLabel(plan: AnaphylaxisPlan): string {
  return plan.carriedAt === "Other"
    ? (plan.carriedAtOther ?? "Other")
    : plan.carriedAt;
}

/**
 * One sentence a screen reader can read aloud verbatim on the public card.
 * Deliberately plain: no abbreviations, no symbols.
 */
export function anaphylaxisPlanReadAloud(plan: AnaphylaxisPlan): string {
  const parts = [
    `Anaphylaxis action plan. Give ${plan.doseMg} milligrams of adrenaline with the ${autoInjectorLabel(plan)} into the outer thigh, then call emergency services.`,
    `The auto-injector is carried: ${carriedAtLabel(plan)}.`,
  ];
  if (plan.priorEvents !== null) {
    parts.push(
      plan.priorEvents === 0
        ? "No previous anaphylaxis events recorded."
        : `${plan.priorEvents} previous anaphylaxis event${plan.priorEvents === 1 ? "" : "s"} recorded.`,
    );
  }
  parts.push(`Plan author: ${plan.planAuthor}.`);
  return parts.join(" ");
}

/**
 * True when the plan should be surfaced above the fold: any high-criticality
 * allergy is present and a plan exists.
 */
export function shouldShowPlanAboveFold(
  hasHighCriticalityAllergy: boolean,
  plan: AnaphylaxisPlan | null | undefined,
): boolean {
  return hasHighCriticalityAllergy && plan !== null && plan !== undefined;
}
