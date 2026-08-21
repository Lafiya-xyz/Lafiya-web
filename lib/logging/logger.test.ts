import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logError, logInfo, redactSensitiveData, redactString } from "./logger";
import * as Sentry from "@sentry/nextjs";

// Mock Sentry to ensure no real network calls are made
vi.mock("@sentry/nextjs", () => {
  return {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    withScope: vi.fn((cb) => cb({ setExtras: vi.fn() })),
  };
});

describe("Structured Logging & Redaction", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  describe("redactString", () => {
    it("should redact email addresses in strings", () => {
      const input = "Error for user test@example.com when processing request";
      const expected =
        "Error for user [REDACTED_EMAIL] when processing request";
      expect(redactString(input)).toBe(expected);
    });

    it("redacts identifiers and commitments embedded in strings", () => {
      expect(
        redactString(
          "user 123e4567-e89b-42d3-a456-426614174000 commitment " +
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ),
      ).toBe("user [REDACTED_ID] commitment [REDACTED_HASH]");
    });

    it("should leave other strings intact", () => {
      const input = "Database connection failed.";
      expect(redactString(input)).toBe(input);
    });
  });

  describe("redactSensitiveData", () => {
    it("should redact top-level sensitive keys case-insensitively", () => {
      const input = {
        name: "John Doe",
        age: 34,
        dateOfBirth: "1992-01-01",
        blood_group: "O+",
        genotype: "AA",
        safeKey: "safeValue",
      };

      const expected = {
        name: "[REDACTED]",
        age: "[REDACTED]",
        dateOfBirth: "[REDACTED]",
        blood_group: "[REDACTED]",
        genotype: "[REDACTED]",
        safeKey: "safeValue",
      };

      expect(redactSensitiveData(input)).toEqual(expected);
    });

    it("should redact nested sensitive keys", () => {
      const input = {
        requestId: "req-123",
        patientData: {
          name: "Jane Doe",
          allergies: ["peanuts"],
          emergency_contacts: [
            { name: "John Doe", phone: "+123456", relationship: "Spouse" },
          ],
        },
      };

      const expected = {
        requestId: "req-123",
        patientData: {
          name: "[REDACTED]",
          allergies: "[REDACTED]",
          emergency_contacts: "[REDACTED]",
        },
      };

      expect(redactSensitiveData(input)).toEqual(expected);
    });

    it("should redact auth credentials and emails in values", () => {
      const input = {
        email: "user@example.com",
        password: "secretpassword123",
        message: "Failed login attempt for admin@lafiya.test",
      };

      const expected = {
        email: "[REDACTED]",
        password: "[REDACTED]",
        message: "Failed login attempt for [REDACTED_EMAIL]",
      };

      expect(redactSensitiveData(input)).toEqual(expected);
    });

    it("redacts identifier, commitment, and credential fields", () => {
      expect(
        redactSensitiveData({
          user_id: "123e4567-e89b-42d3-a456-426614174000",
          recordHash:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          authorization: "Bearer private-capability",
          safeKey: "safeValue",
        }),
      ).toEqual({
        user_id: "[REDACTED]",
        recordHash: "[REDACTED]",
        authorization: "[REDACTED]",
        safeKey: "safeValue",
      });
    });

    it("should redact Error objects properly", () => {
      const err = new Error("Failed to load user@example.com");
      (err as Error & { someField?: string }).someField = "metadata";
      (err as Error & { email?: string }).email = "sensitive@example.com";

      const redacted = redactSensitiveData(err) as Record<string, unknown>;

      expect(redacted.name).toBe("Error");
      expect(redacted.message).toBe("Failed to load [REDACTED_EMAIL]");
      expect(redacted.someField).toBe("metadata");
      expect(redacted.email).toBe("[REDACTED]");
      expect(redacted.stack).toBeDefined();
      expect(redacted.stack as string).toContain(
        "Failed to load [REDACTED_EMAIL]",
      );
    });

    it("should handle arrays of objects and redact them", () => {
      const input = [
        { name: "Alice", id: "1" },
        { name: "Bob", id: "2" },
      ];
      const expected = [
        { name: "[REDACTED]", id: "1" },
        { name: "[REDACTED]", id: "2" },
      ];
      expect(redactSensitiveData(input)).toEqual(expected);
    });

    it("should handle circular references without stack overflow", () => {
      const input: Record<string, unknown> = { key: "value" };
      input.self = input;

      const redacted = redactSensitiveData(input) as Record<string, unknown>;
      expect(redacted.key).toBe("value");
      expect(redacted.self).toBe("[Circular]");
    });
  });

  describe("logger functions", () => {
    it("logError should output structured JSON to console.error and call Sentry", () => {
      const error = new Error("Something went wrong for foo@bar.com");
      const context = { name: "Secret User", action: "signIn" };

      logError("Operation failed for foo@bar.com", error, context);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const loggedString = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedString);

      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("Operation failed for [REDACTED_EMAIL]");
      expect(parsed.error.message).toBe(
        "Something went wrong for [REDACTED_EMAIL]",
      );
      expect(parsed.context.name).toBe("[REDACTED]");
      expect(parsed.context.action).toBe("signIn");
      expect(parsed.timestamp).toBeDefined();

      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Something went wrong for [REDACTED_EMAIL]",
        }),
      );
    });

    it("logInfo should output structured JSON to console.log", () => {
      const context = { action: "signUp", email: "user@example.com" };

      logInfo("User signed up", context);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const loggedString = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedString);

      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("User signed up");
      expect(parsed.context.email).toBe("[REDACTED]");
      expect(parsed.context.action).toBe("signUp");
      expect(parsed.timestamp).toBeDefined();
    });
  });
});
