/**
 * Security-relevant account event catalogue.
 *
 * Each catalogued event maps to a single notification template. Templates are
 * intentionally minimal: they carry only the event type, a coarse time bucket,
 * and a coarse device family. They must never contain PHI (health data,
 * identifiers, capability tokens, IP addresses, exact timestamps, etc.).
 *
 * See issue #534.
 */

export type SecurityEventType =
  | "new_sign_in"
  | "mfa_change"
  | "data_export"
  | "card_rotation";

/** Coarse device family — never a user agent, model, or fingerprint. */
export type DeviceFamily =
  | "desktop"
  | "mobile"
  | "tablet"
  | "unknown";

/**
 * Coarse time bucket. Deliberately imprecise so a leaked notification cannot
 * be correlated with an exact activity timestamp.
 */
export type CoarseTime =
  | "this_morning"
  | "this_afternoon"
  | "this_evening"
  | "recently";

export interface SecurityEventContext {
  deviceFamily: DeviceFamily;
  coarseTime: CoarseTime;
}

/**
 * Data classification for a single payload field, used by the AsyncAPI
 * generator (issue #971). Mirrors the classification vocabulary used by the
 * outbox event schema registry.
 */
export type FieldClassification =
  | "public"
  | "internal"
  | "confidential"
  | "phi";

export interface EventFieldMetadata {
  /** Field name as it appears in the payload schema. */
  name: string;
  /** JSON-schema-ish type descriptor (e.g. "string", "string (enum)"). */
  type: string;
  /** Data classification for this field. */
  classification: FieldClassification;
  /** Human-readable description for the generated docs. */
  description: string;
}

/**
 * Catalog metadata for an event, consumed by the AsyncAPI generator
 * (issue #971). Describes the channel, payload schema, producer, consumers and
 * per-field data classification.
 */
export interface EventCatalogMetadata {
  /** AsyncAPI channel address, e.g. "security.events.new_sign_in". */
  channel: string;
  /** Short human-readable summary of the event. */
  summary: string;
  /** Service(s) that emit the event. */
  producer: string;
  /** Service(s) that consume the event. */
  consumers: string[];
  /** Payload fields with their data classification. */
  fields: EventFieldMetadata[];
}

export interface SecurityEventTemplate {
  /** Stable id used for idempotent dispatch (one notification per event). */
  id: SecurityEventType;
  /** Whether the user may opt out. Critical events are non-optional. */
  optional: boolean;
  /** Localization key for the subject line. */
  subjectKey: string;
  /** Localization key for the body. */
  bodyKey: string;
  /** Catalog metadata for the generated AsyncAPI document (issue #971). */
  catalog: EventCatalogMetadata;
  /**
   * Render the template. Only the event type, coarse time, and device family
   * are interpolated — no PHI, no tokens, no exact timestamps.
   */
  render: (context: SecurityEventContext) => {
    subject: string;
    body: string;
  };
}

const DEVICE_LABELS: Record<DeviceFamily, string> = {
  desktop: "a desktop computer",
  mobile: "a mobile phone",
  tablet: "a tablet",
  unknown: "an unrecognized device",
};

const TIME_LABELS: Record<CoarseTime, string> = {
  this_morning: "this morning",
  this_afternoon: "this afternoon",
  this_evening: "this evening",
  recently: "recently",
};

function describe(context: SecurityEventContext): string {
  const device = DEVICE_LABELS[context.deviceFamily] ?? DEVICE_LABELS.unknown;
  const time = TIME_LABELS[context.coarseTime] ?? TIME_LABELS.recently;
  return `from ${device} ${time}`;
}

/**
 * Payload fields shared by every security notification event. None of these
 * fields carry PHI: the event type is a fixed enum, the device family and time
 * bucket are deliberately coarse, and the localization keys are static.
 */
const SECURITY_EVENT_FIELDS: EventFieldMetadata[] = [
  {
    name: "type",
    type: "string (enum)",
    classification: "internal",
    description: "Security event type; one of the catalogued event ids.",
  },
  {
    name: "deviceFamily",
    type: "string (enum)",
    classification: "internal",
    description:
      "Coarse device family (desktop, mobile, tablet, unknown). Never a user agent or fingerprint.",
  },
  {
    name: "coarseTime",
    type: "string (enum)",
    classification: "internal",
    description:
      "Coarse time bucket (this_morning, this_afternoon, this_evening, recently). Never an exact timestamp.",
  },
  {
    name: "subjectKey",
    type: "string",
    classification: "public",
    description: "Localization key for the notification subject line.",
  },
  {
    name: "bodyKey",
    type: "string",
    classification: "public",
    description: "Localization key for the notification body.",
  },
];

function securityEventCatalog(
  type: SecurityEventType,
  summary: string,
): EventCatalogMetadata {
  return {
    channel: `security.events.${type}`,
    summary,
    producer: "app (security event dispatch)",
    consumers: ["notifications"],
    fields: SECURITY_EVENT_FIELDS,
  };
}

/**
 * The event catalogue. Every security-relevant event that must notify the
 * patient is listed here exactly once. Dispatch is keyed on `id`, which makes
 * notification delivery idempotent per event.
 */
export const SECURITY_EVENT_CATALOGUE: Record<
  SecurityEventType,
  SecurityEventTemplate
> = {
  new_sign_in: {
    id: "new_sign_in",
    optional: false,
    subjectKey: "security.new_sign_in.subject",
    bodyKey: "security.new_sign_in.body",
    catalog: securityEventCatalog(
      "new_sign_in",
      "A new sign-in to the account was detected.",
    ),
    render: (context) => ({
      subject: "New sign-in to your account",
      body: `We noticed a new sign-in to your account ${describe(
        context,
      )}. If this was you, no action is needed. If not, secure your account now.`,
    }),
  },
  mfa_change: {
    id: "mfa_change",
    optional: false,
    subjectKey: "security.mfa_change.subject",
    bodyKey: "security.mfa_change.body",
    catalog: securityEventCatalog(
      "mfa_change",
      "The account's multi-factor authentication settings changed.",
    ),
    render: (context) => ({
      subject: "Your multi-factor authentication settings changed",
      body: `Your multi-factor authentication settings were changed ${describe(
        context,
      )}. If you did not make this change, secure your account now.`,
    }),
  },
  data_export: {
    id: "data_export",
    optional: false,
    subjectKey: "security.data_export.subject",
    bodyKey: "security.data_export.body",
    catalog: securityEventCatalog(
      "data_export",
      "A data export was requested for the account.",
    ),
    render: (context) => ({
      subject: "Your data export was requested",
      body: `A data export was requested ${describe(
        context,
      )}. If you did not request this, secure your account now.`,
    }),
  },
  card_rotation: {
    id: "card_rotation",
    optional: false,
    subjectKey: "security.card_rotation.subject",
    bodyKey: "security.card_rotation.body",
    catalog: securityEventCatalog(
      "card_rotation",
      "The account's card link was rotated.",
    ),
    render: (context) => ({
      subject: "Your card link was rotated",
      body: `Your card link was rotated ${describe(
        context,
      )}. If you did not do this, secure your account now.`,
    }),
  },
};

export const SECURITY_EVENT_TYPES = Object.keys(
  SECURITY_EVENT_CATALOGUE,
) as SecurityEventType[];

/**
 * Catalog metadata for every security notification event, keyed by event type.
 * Exported for the AsyncAPI generator (issue #971) so notification events are
 * documented alongside outbox events.
 */
export const SECURITY_EVENT_CATALOG_METADATA: Record<
  SecurityEventType,
  EventCatalogMetadata
> = Object.fromEntries(
  SECURITY_EVENT_TYPES.map((type) => [
    type,
    SECURITY_EVENT_CATALOGUE[type].catalog,
  ]),
) as Record<SecurityEventType, EventCatalogMetadata>;

/**
 * Resolve the template for an event. Throws for unknown events so a typo can
 * never silently drop a security notification.
 */
export function getSecurityEventTemplate(
  type: SecurityEventType,
): SecurityEventTemplate {
  const template = SECURITY_EVENT_CATALOGUE[type];
  if (!template) {
    throw new Error(`Unknown security event type: ${type}`);
  }
  return template;
}

/**
 * Render a security notification. Only the event type, coarse time, and device
 * family are used; callers must not pass PHI or capability tokens.
 */
export function renderSecurityEvent(
  type: SecurityEventType,
  context: SecurityEventContext,
): { subject: string; body: string } {
  return getSecurityEventTemplate(type).render(context);
}
