/**
 * Issue #929: guided ("step-by-step") profile editor mode.
 *
 * The guided mode is a presentation layer over the *same* form fields and
 * the *same* server action (`upsertProfile`) as the standard editor, so both
 * modes reach an identical data model. This module holds the pure pieces:
 * the mode preference (persisted in localStorage, no PHI), the ordered step
 * definitions, and the plain-language copy for each step.
 */

export type EditorMode = "standard" | "guided";

export const EDITOR_MODE_STORAGE_KEY = "handsoff-profile-editor-mode";

export function parseEditorMode(value: string | null | undefined): EditorMode {
  return value === "guided" ? "guided" : "standard";
}

export type GuidedStepId =
  | "name"
  | "photo"
  | "birthday"
  | "blood"
  | "genotype"
  | "allergies"
  | "conditions"
  | "contacts";

export type GuidedStep = {
  id: GuidedStepId;
  /** Short title shown in the progress list and the step heading. */
  title: string;
  /** Plain-language question, one per screen. */
  question: string;
  /** Optional extra help, always visible (WCAG 3.3.5 consistent help). */
  help?: string;
  /** Decorative icon; never the only carrier of meaning. */
  icon: string;
};

export const GUIDED_STEPS: readonly GuidedStep[] = [
  {
    id: "name",
    title: "Your name",
    question: "What is your name?",
    help: "Use the name you want a helper to see on your card.",
    icon: "👤",
  },
  {
    id: "photo",
    title: "Your photo",
    question: "Do you want to add a photo?",
    help: "A photo helps people recognise you. You can skip this.",
    icon: "📷",
  },
  {
    id: "birthday",
    title: "Your birthday",
    question: "When were you born?",
    help: "This is optional. It helps a doctor know your age.",
    icon: "🎂",
  },
  {
    id: "blood",
    title: "Blood group",
    question: "Do you know your blood group?",
    help: "If you are not sure, choose “Unknown”.",
    icon: "🩸",
  },
  {
    id: "genotype",
    title: "Genotype",
    question: "Do you know your genotype?",
    help: "If you are not sure, choose “Unknown”.",
    icon: "🧬",
  },
  {
    id: "allergies",
    title: "Allergies",
    question: "Are you allergic to anything?",
    help: "Add one allergy at a time, then press Add.",
    icon: "⚠️",
  },
  {
    id: "conditions",
    title: "Medical conditions",
    question: "Do you have any long-term health conditions?",
    help: "Add one condition at a time, then press Add.",
    icon: "🏥",
  },
  {
    id: "contacts",
    title: "Emergency contacts",
    question: "Who should we call in an emergency?",
    help: "Add at least one person we can call.",
    icon: "📞",
  },
] as const;

/** 1-based position of a step, for "Step 3 of 8" progress text. */
export function stepPosition(stepId: GuidedStepId): number {
  return GUIDED_STEPS.findIndex((step) => step.id === stepId) + 1;
}

/** Clamp an arbitrary index into the valid step range. */
export function clampStepIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), GUIDED_STEPS.length - 1);
}

/**
 * Which step should be shown first when the guided editor opens: the first
 * step whose required data is still missing, so a returning user is not
 * asked to re-enter what they already saved.
 */
export function firstIncompleteStep(profile: {
  name?: string | null;
  blood_group?: string | null;
  allergies?: string[] | null;
  emergency_contacts?: unknown[] | null;
} | null): GuidedStepId {
  if (!profile?.name) return "name";
  if (!profile.blood_group || profile.blood_group === "unknown") return "blood";
  if (!profile.allergies || profile.allergies.length === 0) return "allergies";
  if (!profile.emergency_contacts || profile.emergency_contacts.length === 0) {
    return "contacts";
  }
  return "name";
}
