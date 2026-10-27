/**
 * Tests for the versioned outbox schema registry (issue #790).
 *
 * Acceptance criteria:
 * - Writing an invalid payload is rejected before commit.
 * - Dispatching a v1 payload through a v2 handler works via upcaster.
 * - Registry is the single source for handler registration and docs.
 * - Every registered event has fixtures for all supported versions.
 */

import { describe, expect, it } from "vitest";
import {
  OUTBOX_SCHEMA_REGISTRY,
  upcastPayload,
  validateOutboxPayload,
} from "./types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_COMMITMENT = "a".repeat(64);
const VALID_UUID = "12345678-1234-1234-1234-123456789abc";

const FIXTURES: Record<string, Record<number, Record<string, unknown>>> = {
  "record_revision:record_saved": {
    1: {
      schema_version: 1,
      commitment: VALID_COMMITMENT,
    },
    2: {
      schema_version: 2,
      commitment: VALID_COMMITMENT,
      revision_id: VALID_UUID,
    },
  },
};

// ─── Registry completeness ───────────────────────────────────────────────────

describe("OUTBOX_SCHEMA_REGISTRY completeness", () => {
  it("has at least one registered event", () => {
    expect(OUTBOX_SCHEMA_REGISTRY.size).toBeGreaterThan(0);
  });

  for (const [key, entry] of OUTBOX_SCHEMA_REGISTRY.entries()) {
    it(`every version of "${key}" has a fixture`, () => {
      const keyFixtures = FIXTURES[key];
      expect(
        keyFixtures,
        `No fixtures defined for "${key}" — add them to FIXTURES in this file`,
      ).toBeDefined();
      for (const versionEntry of entry.versions) {
        expect(
          keyFixtures[versionEntry.version],
          `Missing fixture for "${key}" version ${versionEntry.version}`,
        ).toBeDefined();
      }
    });
  }
});

// ─── validateOutboxPayload (write-time) ──────────────────────────────────────

describe("validateOutboxPayload", () => {
  it("accepts a valid v2 payload", () => {
    const result = validateOutboxPayload("record_revision:record_saved", {
      schema_version: 2,
      commitment: VALID_COMMITMENT,
      revision_id: VALID_UUID,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid payload (bad commitment)", () => {
    const result = validateOutboxPayload("record_revision:record_saved", {
      schema_version: 2,
      commitment: "not-a-hex-hash",
      revision_id: VALID_UUID,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an old v1 payload on the write path (current version is v2)", () => {
    const result = validateOutboxPayload("record_revision:record_saved", {
      schema_version: 1,
      commitment: VALID_COMMITMENT,
    });
    // v1 payload does not satisfy the v2 (current) schema (missing revision_id)
    expect(result.ok).toBe(false);
  });

  it("passes through unregistered event types", () => {
    const result = validateOutboxPayload("unknown:event", { anything: true });
    expect(result.ok).toBe(true);
  });
});

// ─── upcastPayload (read/dispatch-time) ──────────────────────────────────────

describe("upcastPayload", () => {
  it("accepts a valid v2 payload as-is", () => {
    const result = upcastPayload("record_revision:record_saved", {
      schema_version: 2,
      commitment: VALID_COMMITMENT,
      revision_id: VALID_UUID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload["commitment"]).toBe(VALID_COMMITMENT);
      expect(result.payload["revision_id"]).toBe(VALID_UUID);
    }
  });

  it("upcasts a v1 payload to v2 via upcaster", () => {
    const result = upcastPayload("record_revision:record_saved", {
      schema_version: 1,
      commitment: VALID_COMMITMENT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload["schema_version"]).toBe(2);
      expect(result.payload["commitment"]).toBe(VALID_COMMITMENT);
      // Upcaster fills in sentinel UUID for unknown revision_id
      expect(result.payload["revision_id"]).toBe(
        "00000000-0000-0000-0000-000000000000",
      );
    }
  });

  it("upcasts a legacy row (no schema_version) as v1", () => {
    const result = upcastPayload("record_revision:record_saved", {
      commitment: VALID_COMMITMENT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload["schema_version"]).toBe(2);
      expect(result.payload["commitment"]).toBe(VALID_COMMITMENT);
    }
  });

  it("returns unknown_version for an unrecognised version number", () => {
    const result = upcastPayload("record_revision:record_saved", {
      schema_version: 99,
      commitment: VALID_COMMITMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_version");
    }
  });

  it("returns invalid_payload for a payload that fails its version schema", () => {
    const result = upcastPayload("record_revision:record_saved", {
      schema_version: 1,
      commitment: "not-valid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_payload");
    }
  });

  it("passes through unregistered event types", () => {
    const result = upcastPayload("unknown:event", { anything: true });
    expect(result.ok).toBe(true);
  });
});
