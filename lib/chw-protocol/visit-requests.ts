/**
 * Issue #765: patient-initiated verification visit requests.
 *
 * Pure state machine and privacy projections shared by the patient timeline,
 * the CHW queue and tests. Location is coarse (LGA only) and contact details
 * are only revealed to the matched CHW after explicit patient consent.
 */

export const VISIT_REQUEST_STATUSES = [
  "requested",
  "matched",
  "scheduled",
  "verified",
  "declined",
  "expired",
] as const;

export type VisitRequestStatus = (typeof VISIT_REQUEST_STATUSES)[number];

export const CONTACT_PREFERENCES = ["sms", "phone_call", "whatsapp"] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];

export const CLOSED_VISIT_STATUSES: readonly VisitRequestStatus[] = [
  "verified",
  "declined",
  "expired",
];

/** Closed requests are anonymized after this many days (retention policy). */
export const VISIT_REQUEST_RETENTION_DAYS = 30;

const TRANSITIONS: Record<VisitRequestStatus, readonly VisitRequestStatus[]> = {
  requested: ["matched", "declined", "expired"],
  matched: ["scheduled", "requested", "declined", "expired"],
  scheduled: ["verified", "declined", "expired"],
  verified: [],
  declined: [],
  expired: [],
};

export class InvalidVisitTransitionError extends Error {
  constructor(
    readonly from: VisitRequestStatus,
    readonly to: VisitRequestStatus,
  ) {
    super(`Invalid verification request transition: ${from} -> ${to}`);
    this.name = "InvalidVisitTransitionError";
  }
}

export function canTransitionVisit(
  from: VisitRequestStatus,
  to: VisitRequestStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionVisit(
  from: VisitRequestStatus,
  to: VisitRequestStatus,
): VisitRequestStatus {
  if (!canTransitionVisit(from, to))
    throw new InvalidVisitTransitionError(from, to);
  return to;
}

export function isClosedVisitStatus(status: VisitRequestStatus): boolean {
  return CLOSED_VISIT_STATUSES.includes(status);
}

export type VisitRequest = {
  id: string;
  status: VisitRequestStatus;
  lga: string;
  preferred_language: string | null;
  contact_preference: ContactPreference;
  contact_consent: boolean;
  contact_phone: string | null;
  matched_chw_id: string | null;
  created_at: string;
  updated_at: string;
};

/** What a CHW queue row may contain: the minimum needed to arrange contact. */
export type ChwQueueItem = {
  id: string;
  status: VisitRequestStatus;
  lga: string;
  preferred_language: string | null;
  contact_preference: ContactPreference;
  contact_phone: string | null;
};

/**
 * Projects requests for a CHW: only requests in their assigned areas, and
 * contact details only when the patient consented and this CHW is matched.
 */
export function chwQueue(
  requests: readonly VisitRequest[],
  chwId: string,
  assignedLgas: readonly string[],
): ChwQueueItem[] {
  const areas = new Set(assignedLgas);
  return requests
    .filter((r) => areas.has(r.lga) && !isClosedVisitStatus(r.status))
    .map((r) => ({
      id: r.id,
      status: r.status,
      lga: r.lga,
      preferred_language: r.preferred_language,
      contact_preference: r.contact_preference,
      contact_phone:
        r.contact_consent && r.matched_chw_id === chwId
          ? r.contact_phone
          : null,
    }));
}

/** Retention: strips contact details from a closed request. */
export function anonymizeVisitRequest(request: VisitRequest): VisitRequest {
  if (!isClosedVisitStatus(request.status)) return request;
  return {
    ...request,
    contact_phone: null,
    contact_consent: false,
    preferred_language: null,
    matched_chw_id: null,
  };
}

export const VISIT_STATUS_LABELS: Record<VisitRequestStatus, string> = {
  requested: "Request sent",
  matched: "Health worker matched",
  scheduled: "Visit scheduled",
  verified: "Card verified",
  declined: "Request declined",
  expired: "Request expired",
};
