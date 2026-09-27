import { NextResponse } from "next/server";
import type {
  AllergyIntolerance,
  Bundle,
  Condition,
  MedicationStatement,
  Patient,
} from "fhir/r4";
import { exportMyProfileData } from "../actions";

// Schema documentation: docs/data-export-schema.md — update that file whenever
// the shape returned by exportMyProfileData() changes.
// FHIR mapping documentation: docs/fhir-mapping.md — update that file whenever
// the mapping below changes.

const FHIR_CONTENT_TYPE = "application/fhir+json";

function toFhirBundle(data: Record<string, unknown>): Bundle {
  const now = new Date().toISOString();
  const patientId = "patient-1";

  const patient: Patient = {
    resourceType: "Patient",
    id: patientId,
    name: [
      {
        text: [data.fullName, data.name]
          .find((value) => typeof value === "string" && value.trim())
          ?.toString(),
      },
    ],
    telecom: [],
    identifier: [],
  };

  if (typeof data.phone === "string" && data.phone.trim()) {
    patient.telecom?.push({ system: "phone", value: data.phone });
  }
  if (typeof data.email === "string" && data.email.trim()) {
    patient.telecom?.push({ system: "email", value: data.email });
  }
  if (typeof data.nationalId === "string" && data.nationalId.trim()) {
    patient.identifier?.push({
      system: "urn:lafiya:national-id",
      value: data.nationalId,
    });
  }
  if (typeof data.dateOfBirth === "string" && data.dateOfBirth.trim()) {
    patient.birthDate = data.dateOfBirth;
  }
  if (typeof data.gender === "string" && data.gender.trim()) {
    patient.gender = data.gender.toLowerCase() as Patient["gender"];
  }

  const allergies = Array.isArray(data.allergies) ? data.allergies : [];
  const allergyResources: AllergyIntolerance[] = allergies.map(
    (entry, index) => {
      const allergy = (entry ?? {}) as Record<string, unknown>;
      return {
        resourceType: "AllergyIntolerance",
        id: `allergy-${index + 1}`,
        patient: { reference: `Patient/${patientId}` },
        code: {
          text:
            typeof allergy.name === "string"
              ? allergy.name
              : typeof allergy.substance === "string"
                ? allergy.substance
                : undefined,
        },
        reaction: [
          {
            manifestation: [
              {
                text:
                  typeof allergy.reaction === "string"
                    ? allergy.reaction
                    : undefined,
              },
            ],
          },
        ],
      };
    },
  );

  const medications = Array.isArray(data.medications)
    ? data.medications
    : [];
  const medicationResources: MedicationStatement[] = medications.map(
    (entry, index) => {
      const medication = (entry ?? {}) as Record<string, unknown>;
      return {
        resourceType: "MedicationStatement",
        id: `medication-${index + 1}`,
        status: "active",
        subject: { reference: `Patient/${patientId}` },
        medicationCodeableConcept: {
          text:
            typeof medication.name === "string"
              ? medication.name
              : typeof medication.medication === "string"
                ? medication.medication
                : undefined,
        },
        dosage: [
          {
            text:
              typeof medication.dosage === "string"
                ? medication.dosage
                : undefined,
          },
        ],
      };
    },
  );

  const conditions = Array.isArray(data.conditions) ? data.conditions : [];
  const conditionResources: Condition[] = conditions.map((entry, index) => {
    const condition = (entry ?? {}) as Record<string, unknown>;
    return {
      resourceType: "Condition",
      id: `condition-${index + 1}`,
      subject: { reference: `Patient/${patientId}` },
      code: {
        text:
          typeof condition.name === "string"
            ? condition.name
            : typeof condition.condition === "string"
              ? condition.condition
              : undefined,
      },
    };
  });

  return {
    resourceType: "Bundle",
    id: `lafiya-profile-export-${now.slice(0, 10)}`,
    type: "collection",
    timestamp: now,
    entry: [
      { fullUrl: `urn:uuid:${patientId}`, resource: patient },
      ...allergyResources.map((resource) => ({
        fullUrl: `urn:uuid:${resource.id}`,
        resource,
      })),
      ...medicationResources.map((resource) => ({
        fullUrl: `urn:uuid:${resource.id}`,
        resource,
      })),
      ...conditionResources.map((resource) => ({
        fullUrl: `urn:uuid:${resource.id}`,
        resource,
      })),
    ],
  };
}

export async function GET(request: Request) {
  const result = await exportMyProfileData();

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const format = new URL(request.url).searchParams.get("format");
  const date = new Date().toISOString().slice(0, 10);

  if (format === "fhir") {
    const bundle = toFhirBundle(result.data as Record<string, unknown>);
    const filename = `lafiya-profile-export-${date}.fhir.json`;

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": FHIR_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const filename = `lafiya-profile-export-${date}.json`;

  return new NextResponse(JSON.stringify(result.data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
