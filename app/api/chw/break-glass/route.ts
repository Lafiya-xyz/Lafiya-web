import { NextResponse } from "next/server";
import { z } from "zod";

import { notifyPatientOfBreakGlassAccess } from "@/lib/emergency/break-glass";
import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requestSchema = z.object({
  patientUserId: z.string().regex(UUID_PATTERN, "Must be a valid patient id"),
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required")
    .max(500, "Reason must be 500 characters or fewer"),
});

/**
 * Break-glass read (issue #543). Lets a verified clinician view the
 * restricted fields a patient marked clinician-only, at the cost of an
 * immutable audit row (public.break_glass_accesses) and a post-hoc patient
 * notification. Clinician verification, the audit write, and the field
 * projection all happen inside open_break_glass_access() — this route only
 * validates the request shape, forwards it, and triggers the notification.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        fields: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase.rpc("open_break_glass_access", {
      p_patient_user_id: parsed.data.patientUserId,
      p_reason: parsed.data.reason,
    });

    if (error) {
      if (
        error.message === "CLINICIAN_NOT_VERIFIED" ||
        error.message === "CLINICIAN_CREDENTIAL_EXPIRED"
      ) {
        return NextResponse.json(
          { error: "You are not a verified clinician" },
          { status: 403 },
        );
      }
      if (error.message === "PATIENT_NOT_FOUND") {
        return NextResponse.json(
          { error: "Patient not found" },
          { status: 404 },
        );
      }
      if (error.message === "REASON_REQUIRED") {
        return NextResponse.json(
          {
            error: "A reason is required",
            fields: [{ field: "reason", message: "Required" }],
          },
          { status: 400 },
        );
      }
      logError("Break-glass access failed", error, {
        route: "/api/chw/break-glass",
      });
      return NextResponse.json(
        { error: "Could not open break-glass access. Please try again." },
        { status: 500 },
      );
    }

    const access = data?.[0];
    if (!access) {
      return NextResponse.json(
        { error: "Could not open break-glass access. Please try again." },
        { status: 500 },
      );
    }

    // Post-hoc notification: patient learns about the access only after it
    // has already happened and already been audited, per the issue design.
    await notifyPatientOfBreakGlassAccess({
      accessId: access.access_id,
      patientUserId: parsed.data.patientUserId,
    });

    return NextResponse.json({
      accessId: access.access_id,
      expiresAt: access.expires_at,
      fieldsDisclosed: access.fields_disclosed,
      record: {
        name: access.name,
        age: access.age,
        photoUrl: access.photo_url,
        bloodGroup: access.blood_group,
        genotype: access.genotype,
        allergies: access.allergies,
        medications: access.medications,
        chronicConditions: access.chronic_conditions,
        emergencyContacts: access.emergency_contacts,
        language: access.language,
      },
    });
  } catch (err) {
    logError("Unhandled break-glass access error", err, {
      route: "/api/chw/break-glass",
    });
    return NextResponse.json(
      { error: "Could not open break-glass access. Please try again." },
      { status: 500 },
    );
  }
}
