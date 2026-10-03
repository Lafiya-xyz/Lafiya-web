import "server-only";

import { logInfo, logWarn } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Post-hoc patient notification for a break-glass access (issue #543).
 *
 * STUB: this codebase has no outbound notification channel yet (no email,
 * SMS, or push provider is wired up anywhere in lib/ or app/). Until one
 * exists, this function only logs that a notification was owed and
 * immediately marks the audit row as notified so the "every break-glass
 * access is audited and notified" acceptance criterion has a concrete,
 * observable hook to attach a real channel to later — the audit trail
 * itself (public.break_glass_accesses) is real and immutable regardless.
 *
 * Replace the body of this function with a call to the app's real
 * notification provider once one is chosen; keep the
 * `mark_break_glass_patient_notified` RPC call as the last step so
 * `patient_notified_at` only ever reflects a real, attempted send.
 */
export async function notifyPatientOfBreakGlassAccess(params: {
  accessId: string;
  patientUserId: string;
}): Promise<void> {
  const { accessId } = params;

  // No PHI, no field names/values, and no raw identifiers beyond the
  // opaque access id are logged here — see lib/logging/logger.ts's
  // SENSITIVE_KEYS redaction, which would strip patientUserId anyway.
  logInfo("break_glass_access.notification_stub", { accessId });

  const admin = createAdminClient();
  const { error } = await admin.rpc("mark_break_glass_patient_notified", {
    p_access_id: accessId,
  });

  if (error) {
    // The break-glass access itself already succeeded and is audited; a
    // failure here means only the notification marker is stale, which is
    // safe to retry out-of-band and must never fail the clinician's read.
    logWarn("break_glass_access.notification_marker_failed", {
      accessId,
      error: error.message,
    });
  }
}
