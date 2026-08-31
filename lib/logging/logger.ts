import * as Sentry from "@sentry/nextjs";

/**
 * Hard Rule: Patient health-data fields and authentication credentials
 * must NEVER be logged.
 *
 * The following emergency data model and auth fields are explicitly redacted:
 * - name, age, dateOfBirth/date_of_birth, dob
 * - language, photoUrl/photo_url
 * - bloodGroup/blood_group, genotype
 * - allergies, medications, chronicConditions/chronic_conditions
 * - emergencyContacts/emergency_contacts, phone, relationship
 * - email, password
 * - internal user/record/card identifiers and record commitments
 */
export const SENSITIVE_KEYS = new Set([
  "name",
  "age",
  "dateofbirth",
  "date_of_birth",
  "dob",
  "language",
  "photourl",
  "photo_url",
  "bloodgroup",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronicconditions",
  "chronic_conditions",
  "emergencycontacts",
  "emergency_contacts",
  "phone",
  "relationship",
  "email",
  "password",
  "user_id",
  "userid",
  "record_id",
  "recordid",
  "record_hash",
  "recordhash",
  "card_id",
  "cardid",
  "card_public_id",
  "cardpublicid",
  "commitment",
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "xapikey",
  "api_key",
  "access_token",
  "refresh_token",
  "service_role_key",
  "secret",
  "token",
  "capability",
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const HASH_REGEX = /\b[0-9a-f]{64}\b/gi;
const CAPABILITY_REGEX = /\blafiya_e1_[A-Za-z0-9_-]{43}\b/g;
const BEARER_TOKEN_REGEX = /\bBearer\s+[^\s,;]+/gi;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const STELLAR_SECRET_REGEX = /\bS[A-Z2-7]{55}\b/g;
const PHONE_REGEX = /(?<![A-Za-z0-9])\+?[1-9]\d{7,14}(?![A-Za-z0-9])/g;
const DATE_OF_BIRTH_REGEX =
  /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;

/** Redacts any raw email addresses found in strings. */
export function redactString(val: string): string {
  return val
    .replace(EMAIL_REGEX, "[REDACTED_EMAIL]")
    .replace(UUID_REGEX, "[REDACTED_ID]")
    .replace(HASH_REGEX, "[REDACTED_HASH]")
    .replace(CAPABILITY_REGEX, "[REDACTED_CAPABILITY]")
    .replace(BEARER_TOKEN_REGEX, "[REDACTED_BEARER]")
    .replace(JWT_REGEX, "[REDACTED_JWT]")
    .replace(STELLAR_SECRET_REGEX, "[REDACTED_STELLAR_SECRET]")
    .replace(PHONE_REGEX, "[REDACTED_PHONE]")
    .replace(DATE_OF_BIRTH_REGEX, "[REDACTED_DATE]");
}

/** Recursively redacts sensitive keys and emails from any object/structure. */
export function redactSensitiveData(
  data: unknown,
  visited = new WeakSet<object>(),
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    return redactString(data);
  }

  if (typeof data !== "object") {
    return data;
  }

  if (visited.has(data)) {
    return "[Circular]";
  }

  if (data instanceof Error) {
    const errorObj: Record<string, unknown> = {
      name: data.name,
      message: redactString(data.message),
      stack: data.stack ? redactString(data.stack) : undefined,
    };
    visited.add(data);
    for (const key of Object.keys(data)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        errorObj[key] = "[REDACTED]";
      } else {
        errorObj[key] = redactSensitiveData(
          (data as unknown as Record<string, unknown>)[key],
          visited,
        );
      }
    }
    return errorObj;
  }

  if (Array.isArray(data)) {
    const arrayResult: unknown[] = [];
    visited.add(data);
    for (const item of data) {
      if (item && typeof item === "object") {
        arrayResult.push(redactSensitiveData(item, visited));
      } else {
        arrayResult.push(redactString(String(item)));
      }
    }
    return arrayResult;
  }

  const result: Record<string, unknown> = {};
  visited.add(data);
  for (const key of Object.keys(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitiveData(
        (data as Record<string, unknown>)[key],
        visited,
      );
    }
  }
  return result;
}

/**
 * Logs an error to console.error as structured JSON and captures it in Sentry.
 * Recursively redacts all sensitive fields and email patterns.
 *
 * Sentry errors are caught and never allowed to propagate — a logging failure
 * must not crash whatever code was trying to log something.
 */
export function logError(
  message: string,
  error?: unknown,
  context?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const redactedError =
    error !== undefined ? redactSensitiveData(error) : undefined;
  const redactedContext =
    context !== undefined
      ? (redactSensitiveData(context) as Record<string, unknown>)
      : undefined;

  const logPayload = {
    level: "error",
    message: redactString(message),
    timestamp,
    error: redactedError,
    context: redactedContext,
  };

  console.error(JSON.stringify(logPayload));

  try {
    if (error instanceof Error) {
      Sentry.withScope((scope) => {
        if (redactedContext) {
          scope.setExtras(redactedContext);
        }
        // Never send the original error to telemetry. Database/provider error
        // messages may interpolate identifiers which are not safe to retain.
        Sentry.captureException(new Error(redactString(error.message)));
      });
    } else if (error) {
      Sentry.captureMessage(redactString(message), {
        level: "error",
        extra: {
          error: redactedError,
          ...redactedContext,
        },
      });
    } else {
      Sentry.captureMessage(redactString(message), {
        level: "error",
        extra: redactedContext,
      });
    }
  } catch (sentryError) {
    if (process.env.NODE_ENV === "development") {
      console.warn(
        "[logger] logError: Sentry sink threw — logging is degraded.",
        sentryError,
      );
    }
  }
}

/**
 * Logs information to console.log as structured JSON.
 * Recursively redacts all sensitive fields and email patterns.
 */
export function logInfo(
  message: string,
  context?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const redactedContext =
    context !== undefined
      ? (redactSensitiveData(context) as Record<string, unknown>)
      : undefined;

  const logPayload = {
    level: "info",
    message: redactString(message),
    timestamp,
    context: redactedContext,
  };

  console.log(JSON.stringify(logPayload));
}
