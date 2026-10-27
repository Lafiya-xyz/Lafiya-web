/**
 * Shared types for the transactional outbox (issue #624).
 *
 * All values stored in `outbox.payload` must be opaque identifiers only —
 * no PHI, no capability tokens, no raw user IDs. Use commitment hashes,
 * revision UUIDs, and hashed identifiers.
 */

import { z } from "zod";

export interface OutboxRow {
  id: string;
  aggregate: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  dispatched_at: string | null;
  attempts: number;
}

/**
 * Each handler receives one outbox row and must be idempotent: calling it
 * twice for the same row must produce the same observable outcome as calling
 * it once. The dispatcher guarantees at-least-once delivery.
 */
export type OutboxHandler = (row: OutboxRow) => Promise<void>;

/** Registry mapping `${aggregate}:${event_type}` to a handler. */
export type OutboxHandlerRegistry = Map<string, OutboxHandler>;

// ─── Versioned schema registry (issue #790) ─────────────────────────────────

/**
 * A versioned schema entry: the Zod schema for one version of an event
 * payload, plus an optional upcaster that migrates it to the next version.
 */
export interface OutboxSchemaVersion<
  TIn extends z.ZodTypeAny = z.ZodTypeAny,
  TOut extends z.ZodTypeAny = z.ZodTypeAny,
> {
  version: number;
  schema: TIn;
  /** Migrate a payload validated at `version` to `version + 1`. */
  upcaster?: (payload: z.infer<TIn>) => z.infer<TOut>;
}

/**
 * A registry entry for a single event key (`${aggregate}:${event_type}`).
 * `versions` must be ordered ascending and contiguous from 1.
 * The last entry is the current (canonical) version; it has no upcaster.
 */
export interface OutboxSchemaEntry {
  key: string;
  /** Current (highest) supported schema version. */
  currentVersion: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  versions: OutboxSchemaVersion<any, any>[];
}

/**
 * The global registry: maps event key → schema entry.
 * Built by `registerOutboxSchema`; exported for test introspection.
 */
export const OUTBOX_SCHEMA_REGISTRY = new Map<string, OutboxSchemaEntry>();

/**
 * Register a versioned schema for an event key.
 * Call this once per event type, typically in the same file that defines the
 * event's handler.
 */
export function registerOutboxSchema(entry: OutboxSchemaEntry): void {
  OUTBOX_SCHEMA_REGISTRY.set(entry.key, entry);
}

// ─── Built-in schemas ────────────────────────────────────────────────────────

/**
 * record_revision:record_saved
 *
 * v1: only `commitment`
 * v2: adds `revision_id` (opaque UUID) — upcaster derives a sentinel value
 *     so old rows remain processable.
 */
const recordSavedV1Schema = z.object({
  schema_version: z.literal(1),
  commitment: z.string().regex(/^[0-9a-f]{64}$/),
});

const recordSavedV2Schema = z.object({
  schema_version: z.literal(2),
  commitment: z.string().regex(/^[0-9a-f]{64}$/),
  revision_id: z.string().uuid(),
});

export type RecordSavedV1 = z.infer<typeof recordSavedV1Schema>;
export type RecordSavedV2 = z.infer<typeof recordSavedV2Schema>;

/** Current shape expected by the dispatcher. */
export type RecordSavedPayload = RecordSavedV2;

registerOutboxSchema({
  key: "record_revision:record_saved",
  currentVersion: 2,
  versions: [
    {
      version: 1,
      schema: recordSavedV1Schema,
      upcaster: (v1: RecordSavedV1): RecordSavedV2 => ({
        schema_version: 2,
        commitment: v1.commitment,
        // Sentinel UUID: dispatcher treats this as "revision unknown".
        revision_id: "00000000-0000-0000-0000-000000000000",
      }),
    },
    {
      version: 2,
      schema: recordSavedV2Schema,
      // No upcaster on the current version.
    },
  ],
});

// ─── Upcast helpers ──────────────────────────────────────────────────────────

export type UpcastResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "unknown_version" | "invalid_payload" };

/**
 * Validate and upcast a raw payload to the current version for `key`.
 * Returns `{ ok: false, reason }` when the version is unknown or the
 * payload fails its schema — never throws. Unknown versions go to
 * dead-letter (caller's responsibility).
 */
export function upcastPayload(
  key: string,
  raw: Record<string, unknown>,
): UpcastResult {
  const entry = OUTBOX_SCHEMA_REGISTRY.get(key);
  if (!entry) {
    // No schema registered means we can't validate — treat as unknown.
    return { ok: true, payload: raw };
  }

  const rawVersion = typeof raw["schema_version"] === "number"
    ? (raw["schema_version"] as number)
    : null;

  if (rawVersion === null) {
    // Legacy rows written before schema_version was required: treat as v1.
    const legacyRaw = { ...raw, schema_version: 1 };
    return upcastPayload(key, legacyRaw);
  }

  const versionEntry = entry.versions.find((v) => v.version === rawVersion);
  if (!versionEntry) {
    return { ok: false, reason: "unknown_version" };
  }

  const parsed = versionEntry.schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_payload" };
  }

  let current: Record<string, unknown> = parsed.data as Record<string, unknown>;
  // Walk the upcaster chain from rawVersion → currentVersion.
  for (
    let v = rawVersion;
    v < entry.currentVersion;
    v++
  ) {
    const step = entry.versions.find((ve) => ve.version === v);
    if (!step?.upcaster) break;
    current = step.upcaster(current) as Record<string, unknown>;
  }

  return { ok: true, payload: current };
}

/**
 * Validate a payload for writing.  Rejects payloads whose `schema_version`
 * does not match the current version for `key`.
 * Returns `{ ok: false }` on invalid; throws are reserved for programmer
 * errors (no registered schema).
 */
export function validateOutboxPayload(
  key: string,
  raw: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const entry = OUTBOX_SCHEMA_REGISTRY.get(key);
  if (!entry) {
    // No schema → no constraint; pass through.
    return { ok: true, payload: raw };
  }

  const currentEntry = entry.versions.find(
    (v) => v.version === entry.currentVersion,
  );
  if (!currentEntry) {
    return { ok: false, error: `No schema for version ${entry.currentVersion}` };
  }

  const result = currentEntry.schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }

  return { ok: true, payload: result.data as Record<string, unknown> };
}
