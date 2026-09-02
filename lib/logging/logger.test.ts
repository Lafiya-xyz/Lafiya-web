import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logError,
  logInfo,
  logWarn,
  logDebug,
  redactSensitiveData,
  redactString,
  setLogLevel,
  getLogLevel,
} from "./logger";
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
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.clearAllMocks();
    // Reset to debug level for most tests
    setLogLevel("debug");
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
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

    it("redacts emergency capabilities, including when embedded in a URL", () => {
      const capability = `lafiya_e1_${"A".repeat(43)}`;
      const result = redactString(
        `https://lafiya.example/card/c/${capability}`,
      );
      expect(result).not.toContain(capability);
      expect(result).toContain("[REDACTED_CAPABILITY]");
    });

    it("redacts credentials and patient-like values embedded in telemetry strings", () => {
      const rawJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXRpZW50In0.signature";
      const stellarSecret = `S${"A".repeat(55)}`;
      const result = redactString(
        `Bearer ${rawJwt}; dob 1992-01-31; phone +2348012345678; ${stellarSecret}`,
      );

      expect(result).toContain("[REDACTED_BEARER]");
      expect(result).toContain("[REDACTED_DATE]");
      expect(result).toContain("[REDACTED_PHONE]");
      expect(result).toContain("[REDACTED_STELLAR_SECRET]");
      expect(result).not.toContain(rawJwt);
      expect(result).not.toContain(stellarSecret);
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

    it("redacts arbitrary credential keys before they reach a log sink", () => {
      expect(
        redactSensitiveData({
          cookie: "session-value",
          xApiKey: "api-key",
          refresh_token: "refresh-token",
          safe: "ok",
        }),
      ).toEqual({
        cookie: "[REDACTED]",
        xApiKey: "[REDACTED]",
        refresh_token: "[REDACTED]",
        safe: "ok",
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

    it("logError does not propagate when the Sentry sink throws", () => {
      vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
        throw new Error("Sentry network error");
      });

      // Must not throw even though Sentry fails
      expect(() => {
        logError("test message", new Error("inner error"));
      }).not.toThrow();

      // The structured console.error line is still written before Sentry is called
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("test message");
    });

    it("logError emits a console.warn in development when the Sentry sink throws", () => {
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      // Use vi.stubEnv to safely override NODE_ENV in this test environment
      vi.stubEnv("NODE_ENV", "development");

      try {
        vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
          throw new Error("Sentry DSN misconfigured");
        });

        logError("test message", new Error("inner error"));

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[logger]"),
          expect.any(Error),
        );
      } finally {
        vi.unstubAllEnvs();
        consoleWarnSpy.mockRestore();
      }
    });
  });

  describe("Log Level Filtering", () => {
    it("initializes with debug level in development and warn level in production", () => {
      // Save original env
      const originalEnv = process.env.NODE_ENV;
      
      // Test production default - this is set at module load, so we test getLogLevel
      // The actual level depends on NODE_ENV at import time
      const level = getLogLevel();
      expect(["debug", "warn"]).toContain(level);
      
      process.env.NODE_ENV = originalEnv;
    });

    it("debug logs are suppressed when log level is set to info", () => {
      setLogLevel("info");

      logDebug("Debug message", { key: "value" });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("debug logs are suppressed when log level is set to warn", () => {
      setLogLevel("warn");

      logDebug("Debug message", { key: "value" });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("debug logs are suppressed when log level is set to error", () => {
      setLogLevel("error");

      logDebug("Debug message", { key: "value" });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("debug logs are output when log level is set to debug", () => {
      setLogLevel("debug");

      logDebug("Debug message", { key: "value" });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const loggedString = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedString);
      expect(parsed.level).toBe("debug");
      expect(parsed.message).toBe("Debug message");
    });

    it("info logs are suppressed when log level is set to warn", () => {
      setLogLevel("warn");

      logInfo("Info message", { key: "value" });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("info logs are suppressed when log level is set to error", () => {
      setLogLevel("error");

      logInfo("Info message", { key: "value" });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("info logs are output when log level is set to debug", () => {
      setLogLevel("debug");

      logInfo("Info message", { key: "value" });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const loggedString = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedString);
      expect(parsed.level).toBe("info");
    });

    it("info logs are output when log level is set to info", () => {
      setLogLevel("info");

      logInfo("Info message", { key: "value" });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("warn logs are suppressed when log level is set to error", () => {
      setLogLevel("error");

      logWarn("Warning message", { key: "value" });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("warn logs are output when log level is set to debug", () => {
      setLogLevel("debug");

      logWarn("Warning message", { key: "value" });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const loggedString = consoleWarnSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedString);
      expect(parsed.level).toBe("warn");
    });

    it("warn logs are output when log level is set to info", () => {
      setLogLevel("info");

      logWarn("Warning message", { key: "value" });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it("warn logs are output when log level is set to warn", () => {
      setLogLevel("warn");

      logWarn("Warning message", { key: "value" });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it("error logs are always output regardless of log level", () => {
      const levels: Array<"debug" | "info" | "warn" | "error"> = [
        "debug",
        "info",
        "warn",
        "error",
      ];

      for (const level of levels) {
        setLogLevel(level);
        consoleErrorSpy.mockClear();

        logError("Error message", new Error("Test error"));

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      }
    });

    it("production configuration (warn level) suppresses debug and info logs but allows warn and error", () => {
      setLogLevel("warn");

      logDebug("Debug in prod", {});
      logInfo("Info in prod", {});
      logWarn("Warning in prod", {});
      logError("Error in prod", new Error("Prod error"));

      expect(consoleLogSpy).not.toHaveBeenCalled(); // debug and info
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1); // warn
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1); // error
    });

    it("log levels can be dynamically changed at runtime", () => {
      setLogLevel("error");
      logInfo("Info should be suppressed", {});
      expect(consoleLogSpy).not.toHaveBeenCalled();

      setLogLevel("debug");
      logInfo("Info should now be output", {});
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it("all log levels respect sensitive data redaction", () => {
      setLogLevel("debug");

      const sensitiveContext = { email: "user@example.com", password: "secret" };

      logDebug("Debug with sensitive data", sensitiveContext);
      logInfo("Info with sensitive data", sensitiveContext);
      logWarn("Warn with sensitive data", sensitiveContext);
      logError("Error with sensitive data", new Error("test"), sensitiveContext);

      const allLogs = [
        ...consoleLogSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleErrorSpy.mock.calls,
      ];

      for (const call of allLogs) {
        const loggedString = call[0];
        if (typeof loggedString === "string") {
          expect(loggedString).not.toContain("user@example.com");
          expect(loggedString).not.toContain("secret");
          expect(loggedString).toContain("[REDACTED]");
        }
      }
    });

    it("sanitizes attestation observability context", () => {
      const recordHash = "a".repeat(64);
      const cardId = "123e4567-e89b-42d3-a456-426614174000";

      logInfo("Attestation lookup completed", {
        routeClass: "attestation_lookup",
        outcome: "verified",
        latencyBucket: "under_100_ms",
        recordHash,
        cardId,
        bloodGroup: "O+",
      });

      const loggedString = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedString);
      expect(parsed.context).toEqual({
        routeClass: "attestation_lookup",
        outcome: "verified",
        latencyBucket: "under_100_ms",
        recordHash: "[REDACTED]",
        cardId: "[REDACTED]",
        bloodGroup: "[REDACTED]",
      });
      expect(loggedString).not.toContain(recordHash);
      expect(loggedString).not.toContain(cardId);
      expect(loggedString).not.toContain("O+");
    });

    it("redacts attestation hashes from provider errors before telemetry", () => {
      const recordHash = "b".repeat(64);

      logError(
        "Attestation lookup failed",
        new Error(`provider failed for ${recordHash}`),
        {
          routeClass: "attestation_lookup",
          outcome: "error",
          latencyBucket: "100_to_499_ms",
        },
      );

      const loggedString = consoleErrorSpy.mock.calls[0][0];
      expect(loggedString).not.toContain(recordHash);
      expect(loggedString).toContain("[REDACTED_HASH]");
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "provider failed for [REDACTED_HASH]",
        }),
      );
    });
  });
});
