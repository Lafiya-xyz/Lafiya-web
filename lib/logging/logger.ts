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
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Redacts any raw email addresses found in strings. */
export function redactString(val: string): string {
  return val.replace(EMAIL_REGEX, "[REDACTED_EMAIL]");
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

  if (error instanceof Error) {
    Sentry.withScope((scope) => {
      if (redactedContext) {
        scope.setExtras(redactedContext);
      }
      Sentry.captureException(error);
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
