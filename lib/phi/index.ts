/**
 * lib/phi/ — PHI core module boundary (#972)
 *
 * This module is the ONLY place allowed to read PHI columns/tables.
 * All other modules must consume the purpose-specific projections exported
 * here instead of querying PHI tables directly.
 *
 * Ownership: PHI area reviewers must approve any change in this directory.
 * See lib/phi/README.md for review rules and import-boundary enforcement.
 *
 * Projections:
 *  - emergencyEnvelope  — minimal data needed for emergency responders
 *  - exportBundle       — full user-requested data export
 *  - pdfData            — data shaped for PDF rendering
 *  - passContent        — data embedded in a health pass
 *  - chwVerificationView — data shown to a CHW verifying a pass
 */

import { db } from '@/lib/db';

/* -------------------------------------------------------------------------- */
/* Shared types                                                               */
/* -------------------------------------------------------------------------- */

export interface PhiSubject {
  id: string;
}

export interface EmergencyEnvelope {
  subjectId: string;
  fullName: string | null;
  dateOfBirth: string | null;
  bloodType: string | null;
  allergies: string[];
  criticalMedications: string[];
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  updatedAt: string | null;
}

export interface ExportBundle {
  subjectId: string;
  generatedAt: string;
  profile: {
    fullName: string | null;
    dateOfBirth: string | null;
    sex: string | null;
    bloodType: string | null;
    phone: string | null;
    email: string | null;
  };
  medical: {
    allergies: string[];
    conditions: string[];
    medications: string[];
    immunizations: Array<{ name: string; administeredAt: string | null }>;
  };
  records: Array<{
    id: string;
    kind: string;
    title: string | null;
    createdAt: string;
  }>;
}

export interface PdfData {
  subjectId: string;
  title: string;
  generatedAt: string;
  fullName: string | null;
  dateOfBirth: string | null;
  bloodType: string | null;
  allergies: string[];
  conditions: string[];
  medications: string[];
  immunizations: Array<{ name: string; administeredAt: string | null }>;
}

export interface PassContent {
  subjectId: string;
  passId: string;
  issuedAt: string;
  expiresAt: string | null;
  displayName: string | null;
  bloodType: string | null;
  allergies: string[];
  verificationCode: string | null;
}

export interface ChwVerificationView {
  subjectId: string;
  passId: string;
  verified: boolean;
  displayName: string | null;
  dateOfBirth: string | null;
  bloodType: string | null;
  allergies: string[];
  criticalMedications: string[];
  issuedAt: string | null;
  expiresAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Internal PHI access helpers                                                */
/* -------------------------------------------------------------------------- */

interface RawPhiRow {
  id: string;
  fullName: string | null;
  dateOfBirth: string | null;
  sex: string | null;
  bloodType: string | null;
  phone: string | null;
  email: string | null;
  allergies: string[] | null;
  conditions: string[] | null;
  medications: string[] | null;
  criticalMedications: string[] | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  immunizations: Array<{ name: string; administeredAt: string | null }> | null;
  updatedAt: string | null;
}

interface RawRecordRow {
  id: string;
  subjectId: string;
  kind: string;
  title: string | null;
  createdAt: string;
}

interface RawPassRow {
  id: string;
  subjectId: string;
  issuedAt: string;
  expiresAt: string | null;
  verificationCode: string | null;
}

function toStringArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toImmunizations(
  value: Array<{ name: string; administeredAt: string | null }> | null | undefined,
): Array<{ name: string; administeredAt: string | null }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v.name === 'string')
    .map((v) => ({ name: v.name, administeredAt: v.administeredAt ?? null }));
}

/**
 * Reads the raw PHI profile row for a subject.
 * Internal to lib/phi/ — never export this.
 */
async function readPhiProfile(subjectId: string): Promise<RawPhiRow | null> {
  const row = await db.phiProfile.findUnique({ where: { id: subjectId } });
  return (row as RawPhiRow | null) ?? null;
}

/**
 * Reads raw PHI record rows for a subject.
 * Internal to lib/phi/ — never export this.
 */
async function readPhiRecords(subjectId: string): Promise<RawRecordRow[]> {
  const rows = await db.phiRecord.findMany({
    where: { subjectId },
    orderBy: { createdAt: 'desc' },
  });
  return (rows as RawRecordRow[]) ?? [];
}

/**
 * Reads a raw PHI pass row.
 * Internal to lib/phi/ — never export this.
 */
async function readPhiPass(passId: string): Promise<RawPassRow | null> {
  const row = await db.phiPass.findUnique({ where: { id: passId } });
  return (row as RawPassRow | null) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Emergency envelope: the minimal PHI set an emergency responder needs.
 * Returns null when the subject has no PHI profile.
 */
export async function getEmergencyEnvelope(
  subjectId: string,
): Promise<EmergencyEnvelope | null> {
  const row = await readPhiProfile(subjectId);
  if (!row) return null;

  return {
    subjectId: row.id,
    fullName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    bloodType: row.bloodType,
    allergies: toStringArray(row.allergies),
    criticalMedications: toStringArray(row.criticalMedications),
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    updatedAt: row.updatedAt,
  };
}

/**
 * Export bundle: the full PHI set for a user-requested data export.
 * Returns null when the subject has no PHI profile.
 */
export async function getExportBundle(subjectId: string): Promise<ExportBundle | null> {
  const row = await readPhiProfile(subjectId);
  if (!row) return null;

  const records = await readPhiRecords(subjectId);

  return {
    subjectId: row.id,
    generatedAt: new Date().toISOString(),
    profile: {
      fullName: row.fullName,
      dateOfBirth: row.dateOfBirth,
      sex: row.sex,
      bloodType: row.bloodType,
      phone: row.phone,
      email: row.email,
    },
    medical: {
      allergies: toStringArray(row.allergies),
      conditions: toStringArray(row.conditions),
      medications: toStringArray(row.medications),
      immunizations: toImmunizations(row.immunizations),
    },
    records: records.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      createdAt: r.createdAt,
    })),
  };
}

/**
 * PDF data: PHI shaped for PDF rendering.
 * Returns null when the subject has no PHI profile.
 */
export async function getPdfData(
  subjectId: string,
  options: { title?: string } = {},
): Promise<PdfData | null> {
  const row = await readPhiProfile(subjectId);
  if (!row) return null;

  return {
    subjectId: row.id,
    title: options.title ?? 'Health Record',
    generatedAt: new Date().toISOString(),
    fullName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    bloodType: row.bloodType,
    allergies: toStringArray(row.allergies),
    conditions: toStringArray(row.conditions),
    medications: toStringArray(row.medications),
    immunizations: toImmunizations(row.immunizations),
  };
}

/**
 * Pass content: PHI embedded in a health pass.
 * Returns null when the pass or its subject PHI profile is missing.
 */
export async function getPassContent(passId: string): Promise<PassContent | null> {
  const pass = await readPhiPass(passId);
  if (!pass) return null;

  const row = await readPhiProfile(pass.subjectId);
  if (!row) return null;

  return {
    subjectId: row.id,
    passId: pass.id,
    issuedAt: pass.issuedAt,
    expiresAt: pass.expiresAt,
    displayName: row.fullName,
    bloodType: row.bloodType,
    allergies: toStringArray(row.allergies),
    verificationCode: pass.verificationCode,
  };
}

/**
 * CHW verification view: PHI shown to a community health worker verifying a pass.
 * Returns null when the pass or its subject PHI profile is missing.
 */
export async function getChwVerificationView(
  passId: string,
): Promise<ChwVerificationView | null> {
  const pass = await readPhiPass(passId);
  if (!pass) return null;

  const row = await readPhiProfile(pass.subjectId);
  if (!row) return null;

  const now = Date.now();
  const expiresAtMs = pass.expiresAt ? Date.parse(pass.expiresAt) : null;
  const verified = expiresAtMs === null || Number.isNaN(expiresAtMs) || expiresAtMs > now;

  return {
    subjectId: row.id,
    passId: pass.id,
    verified,
    displayName: row.fullName,
    dateOfBirth: row.dateOfBirth,
    bloodType: row.bloodType,
    allergies: toStringArray(row.allergies),
    criticalMedications: toStringArray(row.criticalMedications),
    issuedAt: pass.issuedAt,
    expiresAt: pass.expiresAt,
  };
}