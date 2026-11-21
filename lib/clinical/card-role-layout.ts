/**
 * Issue #921: role-tailored card layouts.
 *
 * Responders read the emergency card in a different order depending on their
 * role: a paramedic wants allergies/medications first, an ED clinician wants
 * conditions and blood group, a pharmacist wants the medication list and
 * allergy cross-reactivity. This module owns the ordering only — every role
 * renders the same set of sections, so no field is ever hidden.
 *
 * The choice is persisted per device in localStorage (see
 * app/(public)/card/[id]/role-selector.tsx) so it works offline and never
 * leaves the device.
 */

export const CARD_ROLES = ["paramedic", "ed_clinician", "pharmacist"] as const;

export type CardRole = (typeof CARD_ROLES)[number];

export const DEFAULT_CARD_ROLE: CardRole = "paramedic";

/** localStorage key holding the responder's role choice. */
export const CARD_ROLE_STORAGE_KEY = "lafiya-card-role";

export const CARD_ROLE_LABELS: Record<CardRole, string> = {
  paramedic: "Paramedic",
  ed_clinician: "ED clinician",
  pharmacist: "Pharmacist",
};

/**
 * Every section of the public card. The union is exhaustive on purpose: a new
 * section must be added here, which forces a decision about its position in
 * each role's order below.
 */
export const CARD_SECTIONS = [
  "trust",
  "identity",
  "alerts",
  "critical_facts",
  "clinical_summary",
  "contacts",
  "pin_gate",
  "emergency_contacts",
  "notify_contacts",
  "facility_directory",
] as const;

export type CardSection = (typeof CARD_SECTIONS)[number];

/**
 * Per-role section order. Each array is a permutation of CARD_SECTIONS —
 * enforced by `isCompleteRoleOrder` and covered by a unit test — so a role can
 * only reorder, never drop, a section.
 */
export const CARD_ROLE_ORDER: Record<CardRole, readonly CardSection[]> = {
  paramedic: [
    "trust",
    "identity",
    "alerts",
    "critical_facts",
    "clinical_summary",
    "contacts",
    "pin_gate",
    "emergency_contacts",
    "notify_contacts",
    "facility_directory",
  ],
  ed_clinician: [
    "trust",
    "identity",
    "alerts",
    "clinical_summary",
    "critical_facts",
    "contacts",
    "pin_gate",
    "emergency_contacts",
    "notify_contacts",
    "facility_directory",
  ],
  pharmacist: [
    "trust",
    "identity",
    "alerts",
    "critical_facts",
    "contacts",
    "clinical_summary",
    "pin_gate",
    "emergency_contacts",
    "notify_contacts",
    "facility_directory",
  ],
};

export function isCardRole(value: unknown): value is CardRole {
  return (
    typeof value === "string" && (CARD_ROLES as readonly string[]).includes(value)
  );
}

/** True when `order` contains every section exactly once. */
export function isCompleteRoleOrder(
  order: readonly CardSection[],
): boolean {
  if (order.length !== CARD_SECTIONS.length) return false;
  const seen = new Set<CardSection>(order);
  return seen.size === CARD_SECTIONS.length;
}

/**
 * Resolve a stored/unknown value to a role, falling back to the default so a
 * corrupted or stale localStorage entry never breaks the card.
 */
export function resolveCardRole(value: unknown): CardRole {
  return isCardRole(value) ? value : DEFAULT_CARD_ROLE;
}

/** The section order for a role (always a complete permutation). */
export function sectionOrderForRole(
  role: CardRole,
): readonly CardSection[] {
  const order = CARD_ROLE_ORDER[role];
  return isCompleteRoleOrder(order) ? order : CARD_ROLE_ORDER[DEFAULT_CARD_ROLE];
}
