/**
 * CHW training and certification currency (issue #912).
 *
 * A CHW may only attest field categories they hold a *current* certification
 * for. Certifications are issued by a training module's issuer and expire;
 * an expired or missing certification gates the category.
 *
 * Privacy: certifications carry no patient data. Only category identifiers,
 * issuer names and dates are handled here.
 */

import { ProtocolError } from "./types";

/** Field categories that can be gated behind a certification. */
export const GATED_FIELD_CATEGORIES = [
  "identity",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
  "emergency_contacts",
] as const;

export type GatedFieldCategory = (typeof GATED_FIELD_CATEGORIES)[number];

export function isGatedFieldCategory(value: string): value is GatedFieldCategory {
  return (GATED_FIELD_CATEGORIES as readonly string[]).includes(value);
}

/** A training module a CHW can complete to earn a certification. */
export type TrainingModule = {
  id: string;
  /** Stable slug used in certification records. */
  code: string;
  title: string;
  /** Field categories unlocked by completing this module. */
  categories: GatedFieldCategory[];
  /** Validity of the certification issued on completion, in months. */
  validityMonths: number;
};

/** A certification held by a CHW, as stored in `chw_certifications`. */
export type ChwCertification = {
  id: string;
  chwId: string;
  moduleCode: string;
  issuer: string;
  categories: GatedFieldCategory[];
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
};

/** A certification is current when issued, not revoked, and not yet expired. */
export function isCertificationCurrent(
  certification: Pick<ChwCertification, "issuedAt" | "expiresAt" | "revokedAt">,
  now: Date = new Date(),
): boolean {
  if (certification.revokedAt) return false;
  if (certification.issuedAt > now) return false;
  return certification.expiresAt > now;
}

/** Categories the CHW currently holds a certification for. */
export function currentCategories(
  certifications: readonly ChwCertification[],
  now: Date = new Date(),
): Set<GatedFieldCategory> {
  const held = new Set<GatedFieldCategory>();
  for (const certification of certifications) {
    if (!isCertificationCurrent(certification, now)) continue;
    for (const category of certification.categories) held.add(category);
  }
  return held;
}

/**
 * Rejects an attestation intent whose disclosed fields include a gated
 * category the CHW is not currently certified for.
 *
 * @throws ProtocolError("CHW_CERTIFICATION_REQUIRED") naming the first
 *   uncertified category in the error message.
 */
export function assertCertifiedForCategories(
  categories: readonly string[],
  certifications: readonly ChwCertification[],
  now: Date = new Date(),
): void {
  const held = currentCategories(certifications, now);
  for (const category of categories) {
    if (!isGatedFieldCategory(category)) continue;
    if (!held.has(category)) {
      throw new ProtocolError(
        "CHW_CERTIFICATION_REQUIRED",
        `CHW_CERTIFICATION_REQUIRED:${category}`,
      );
    }
  }
}

/** Certifications expiring within `windowDays`, for expiry notifications. */
export function expiringCertifications(
  certifications: readonly ChwCertification[],
  windowDays: number,
  now: Date = new Date(),
): ChwCertification[] {
  const horizon = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
  return certifications.filter(
    (certification) =>
      isCertificationCurrent(certification, now) && certification.expiresAt <= horizon,
  );
}
