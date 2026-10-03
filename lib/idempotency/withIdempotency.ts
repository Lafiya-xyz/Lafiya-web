/**
 * Server Action idempotency wrapper (issue #626).
 *
 * Usage:
 *
 * ```ts
 * export async function regenerateCardId(
 *   _prevState: { error?: string } | undefined,
 *   formData: FormData,
 * ) {
 *   return withIdempotency(
 *     { formData, action: "regenerateCardId" },
 *     async () => { ... actual logic ... },
 *   );
 * }
 * ```
 *
 * The form must include a hidden `idempotencyKey` input containing a UUID
 * generated per render (see IdempotencyKeyInput).  Without the key the action
 * runs normally with no idempotency protection — non-destructive actions can
 * omit it safely.
 *
 * Privacy: `response` stored in the DB must contain only status codes and
 * opaque IDs — never PHI, capability tokens, or raw user IDs.
 */

import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logError, logWarn } from "@/lib/logging/logger";

export interface IdempotencyOptions {
  /** FormData from the Server Action — used to extract the key and compute the hash. */
  formData: FormData;
  /** Discriminator matching the Server Action function name. */
  action: string;
  /**
   * Fields to EXCLUDE from the request hash (e.g. fields that vary on every
   * render but are not semantically part of the payload).  The
   * `idempotencyKey` field is always excluded automatically.
   */
  excludeFields?: string[];
}

/**
 * Compute a stable SHA-256 hash of the FormData entries, excluding the
 * idempotency key itself and any caller-specified fields.
 */
function computeRequestHash(
  formData: FormData,
  excludeFields: string[] = [],
): string {
  const excluded = new Set(["idempotencyKey", ...excludeFields]);
  const entries: [string, string][] = [];
  for (const [key, value] of formData.entries()) {
    if (!excluded.has(key)) {
      entries.push([key, value.toString()]);
    }
  }
  // Sort for determinism regardless of submission order.
  entries.sort(([a], [b]) => a.localeCompare(b));
  const canonical = JSON.stringify(entries);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Wraps a Server Action with idempotency semantics.
 *
 * @param options  Idempotency options.
 * @param fn       The actual action implementation.
 * @returns The action result (either freshly computed or replayed from cache).
 */
export async function withIdempotency<T extends Record<string, unknown>>(
  options: IdempotencyOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { formData, action, excludeFields } = options;

  const rawKey = formData.get("idempotencyKey");
  if (!rawKey || typeof rawKey !== "string") {
    // No key provided — run without idempotency protection.
    return fn();
  }

  // Validate UUID format.
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(rawKey)) {
    logWarn("idempotency: invalid key format — running without protection", {
      action,
    });
    return fn();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Auth check is the caller's responsibility; just run the action.
    return fn();
  }

  const requestHash = computeRequestHash(formData, excludeFields);
  const admin = createAdminClient();

  let insertResult: { duplicate: boolean; response: Record<string, unknown> } | null =
    null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("insert_or_fetch_idempotency_key", {
      p_user_id: user.id,
      p_key: rawKey,
      p_action: action,
      p_request_hash: requestHash,
      p_response: null,
    });

    if (error) {
      if (error.message?.includes("IDEMPOTENCY_HASH_MISMATCH")) {
        return {
          error: "This action was already submitted with different data. Please reload the page.",
        } as unknown as T;
      }
      // DB error — log and fall through to run the action without idempotency.
      logError("idempotency: insert_or_fetch failed — running without protection", error, {
        action,
      });
      return fn();
    }

    insertResult = data as { duplicate: boolean; response: Record<string, unknown> };
  } catch (err) {
    logError("idempotency: unexpected error — running without protection", err, { action });
    return fn();
  }

  // Duplicate — replay the stored response.
  if (insertResult?.duplicate) {
    return insertResult.response as T;
  }

  // First occurrence — run the action and persist the result.
  const result = await fn();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).rpc("insert_or_fetch_idempotency_key", {
      p_user_id: user.id,
      p_key: rawKey,
      p_action: action,
      p_request_hash: requestHash,
      p_response: result,
    });
  } catch (err) {
    // Best-effort result persistence — the action already ran successfully.
    logError("idempotency: failed to persist result — duplicates will re-run", err, {
      action,
    });
  }

  return result;
}
