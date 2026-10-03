# FHIR R4 Export Mapping

This document describes how a patient profile is mapped to a FHIR R4 Bundle when
the owner exports their record from `app/(auth)/profile/export/route.ts`.

The export is produced as a single `Bundle` of type `collection` with
`resourceType: "Bundle"` and serialized as `application/fhir+json`. All
references between resources are **contained within the bundle** using
`urn:uuid:` identifiers, so the bundle is self-contained and importable by
systems such as OpenMRS or DHIS2 tracker integrations without resolving
external references.

## Bundle structure

| Bundle entry | FHIR resource | Source profile field |
| --- | --- | --- |
| 0 | `Patient` | identity fields (name, birth date, sex, identifiers) |
| 1..n | `AllergyIntolerance` | structured allergies |
| 1..n | `MedicationStatement` | current medications |
| 1..n | `Condition` | chronic conditions / diagnoses |

Every entry carries a `fullUrl` of the form `urn:uuid:<uuid>` and the resource
itself. Resources that refer to the patient use
`subject.reference = "urn:uuid:<patient-uuid>"`.

## Patient

| Profile field | FHIR element |
| --- | --- |
| full name | `Patient.name[0].text` |
| given name | `Patient.name[0].given[0]` |
| family name | `Patient.name[0].family` |
| date of birth | `Patient.birthDate` (ISO `YYYY-MM-DD`) |
| sex / gender | `Patient.gender` (`male` \| `female` \| `other` \| `unknown`) |
| national ID / card id | `Patient.identifier[].value` with `Patient.identifier[].system` |
| phone | `Patient.telecom` (`system: "phone"`) |
| email | `Patient.telecom` (`system: "email"`) |
| address | `Patient.address` |

## AllergyIntolerance

| Profile field | FHIR element |
| --- | --- |
| allergen / substance | `AllergyIntolerance.code.text` |
| reaction | `AllergyIntolerance.reaction[0].manifestation[0].text` |
| severity | `AllergyIntolerance.reaction[0].severity` (`mild` \| `moderate` \| `severe`) |
| status | `AllergyIntolerance.clinicalStatus` |
| verification | `AllergyIntolerance.verificationStatus` |
| recorded date | `AllergyIntolerance.recordedDate` |

`AllergyIntolerance.patient` references the `Patient` entry.

## MedicationStatement

| Profile field | FHIR element |
| --- | --- |
| medication name | `MedicationStatement.medicationCodeableConcept.text` |
| dose | `MedicationStatement.dosage[0].text` |
| frequency | `MedicationStatement.dosage[0].timing.code.text` |
| status | `MedicationStatement.status` (`active` \| `completed` \| `stopped`) |
| start date | `MedicationStatement.effectivePeriod.start` |
| end date | `MedicationStatement.effectivePeriod.end` |

`MedicationStatement.subject` references the `Patient` entry.

## Condition

| Profile field | FHIR element |
| --- | --- |
| condition name | `Condition.code.text` |
| clinical status | `Condition.clinicalStatus` |
| verification status | `Condition.verificationStatus` |
| onset date | `Condition.onsetDateTime` |
| recorded date | `Condition.recordedDate` |

`Condition.subject` references the `Patient` entry.

## Validation

The generated bundle is validated against the official FHIR R4 JSON schema
(`@types/fhir` typings are used for compile-time safety). The export must
validate with zero errors. Golden-file tests assert the serialized bundle shape,
and schema validation runs in CI.

## Privacy

The export is only available to the authenticated owner of the record. No PHI is
logged, persisted to third parties, or sent to external services during export;
the bundle is generated in-process and streamed back to the owner as a download.
