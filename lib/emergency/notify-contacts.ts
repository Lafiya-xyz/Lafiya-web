import "server-only";

import type { EmergencyContact } from "@/lib/supabase/types";

export interface NotifyContactsInput {
  contacts: EmergencyContact[];
  /** First name only, and only when the patient's disclosure policy shows
   * their name on the card (mirrors notify_emergency_contacts()'s own
   * disclosure-policy check) — never a full name or any clinical field. */
  patientFirstName: string | null;
  facilityName: string | null;
}

/**
 * Builds the templated notification message (Issue #542). Intentionally
 * contains no health data — only that the patient is receiving care and the
 * optional facility name. Copy is a placeholder pending the clinical-review
 * sign-off the issue's acceptance criteria require before this ships.
 */
export function buildEmergencyContactMessage({
  patientFirstName,
  facilityName,
}: Pick<NotifyContactsInput, "patientFirstName" | "facilityName">): string {
  const who = patientFirstName ? patientFirstName : "Your family member";
  const where = facilityName ? ` at ${facilityName}` : "";
  return (
    `Lafiya emergency alert: ${who} is currently receiving care${where}. ` +
    "This message was sent by a responder who scanned their emergency " +
    "card. No medical details are shared."
  );
}

/**
 * STUB — send function (Issue #542).
 *
 * This codebase does not yet wire up an SMS/email provider (Twilio, Resend,
 * SendGrid, etc.) or an outbox/notification-service module -- confirmed by
 * searching the tree before writing this. This function is the single,
 * clearly-marked call site a future outbox/notification-service integration
 * should replace with a real dispatch to `contacts[].phone`.
 *
 * It deliberately does not log or persist contact phone numbers, emails, or
 * message bodies -- consistent with lib/logging/logger.ts's "no PHI/secrets
 * in logs" rule applied to contact PII as well.
 */
export async function sendEmergencyContactNotification(
  input: NotifyContactsInput,
): Promise<void> {
  const message = buildEmergencyContactMessage(input);
  void message;
  void input.contacts;
  // TODO(#542): replace with a real SMS/email dispatch through the outbox
  // and notification service once one exists in this codebase. Until then,
  // this call site is a documented no-op so consent gating, rate limiting,
  // and the audit trail can ship and be reviewed independently of provider
  // selection.
}
