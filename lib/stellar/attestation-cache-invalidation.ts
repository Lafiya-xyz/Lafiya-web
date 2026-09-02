/**
 * Ledger-aware cache invalidation for attestations.
 *
 * When a new attestation is recorded on-chain (detected via indexer),
 * proactively invalidate the cached attestation for that record hash,
 * ensuring the next verification read hits fresh Soroban RPC data.
 *
 * Also handles:
 * - Revocation: invalidate and flip verified status
 * - Expiry: invalidate for time-based freshness
 * - Provider disagreement: invalidate on detected reorg
 * - Duplicate events: idempotent invalidation (safe to call multiple times)
 */

import { revalidateTag } from "next/cache";
import { logError, logInfo, logWarn } from "@/lib/logging/logger";

/**
 * Proactively invalidate the attestation cache for a record hash.
 * Called when the indexer detects a new attestation on-chain.
 *
 * This ensures that the public card page's next verification read
 * queries fresh Soroban RPC instead of returning a stale cached value.
 *
 * Safe to call multiple times (idempotent); silently handles errors.
 */
export async function invalidateAttestationCache(
  recordHash: string,
  reason: "new_attestation" | "revoked" | "reorg_detected" | "provider_disagreement" = "new_attestation",
): Promise<void> {
  try {
    // Per-hash invalidation (when per-hash tags are implemented).
    // For now, uses generic "attestation" tag which invalidates all hashes.
    const tag = `attestation:${recordHash}`;

    revalidateTag(tag);

    logInfo("Attestation cache invalidated", {
      recordHash,
      reason,
      tag,
    });
  } catch (error) {
    // Cache invalidation errors should not block the indexer or break verification.
    // Log and continue; the cache will expire naturally via TTL.
    logWarn("Attestation cache invalidation failed (non-blocking)", error, {
      recordHash,
      reason,
    });
  }
}

/**
 * Batch invalidate attestation caches for multiple record hashes.
 * Called when reconciliation detects bulk inconsistencies.
 *
 * Returns count of successful invalidations; failures are logged but don't block.
 */
export async function invalidateAttestationCacheBatch(
  recordHashes: string[],
  reason: "reconciliation" | "bulk_reorg" | "provider_recovery" = "reconciliation",
): Promise<number> {
  let successCount = 0;
  const errors: Array<{ hash: string; error: unknown }> = [];

  for (const hash of recordHashes) {
    try {
      await invalidateAttestationCache(hash, "reorg_detected");
      successCount++;
    } catch (error) {
      errors.push({ hash, error });
    }
  }

  if (errors.length > 0) {
    logError("Batch attestation cache invalidation had failures", new Error(`${errors.length}/${recordHashes.length} failed`), {
      reason,
      failureCount: errors.length,
      failedHashes: errors.map((e) => e.hash),
    });
  }

  logInfo("Batch attestation cache invalidation complete", {
    reason,
    total: recordHashes.length,
    successful: successCount,
    failed: errors.length,
  });

  return successCount;
}

/**
 * Invalidate all attestation caches (nuclear option).
 * Used only in extreme scenarios (e.g., discovered contract corruption,
 * provider completely diverged).
 *
 * This uses the generic "attestation" tag, affecting all record hashes at once.
 */
export async function invalidateAllAttestationCaches(): Promise<void> {
  try {
    revalidateTag("attestation");
    logWarn("All attestation caches invalidated (global)");
  } catch (error) {
    logError("Global attestation cache invalidation failed", error);
  }
}

/**
 * Policy-driven cache invalidation based on observed conflict type.
 * Automatically decides whether to invalidate, and at what scope.
 */
export async function invalidateByConflictType(
  conflictType: string,
  recordHash?: string,
  recordHashes?: string[],
): Promise<void> {
  switch (conflictType) {
    case "revoked_attestation":
      // Single record revoked: invalidate just that hash
      if (recordHash) {
        await invalidateAttestationCache(recordHash, "revoked");
      }
      break;

    case "reorg_detected":
      // Reorg: invalidate affected hashes or all if unknown scope
      if (recordHashes?.length) {
        await invalidateAttestationCacheBatch(recordHashes, "bulk_reorg");
      } else if (recordHash) {
        await invalidateAttestationCache(recordHash, "reorg_detected");
      } else {
        // Unknown scope: play it safe, invalidate all
        await invalidateAllAttestationCaches();
      }
      break;

    case "provider_disagreement":
      // Provider disagreement: wide scope, invalidate all to be safe
      await invalidateAllAttestationCaches();
      break;

    case "checksum_mismatch":
      // Data integrity issue: don't trust any cache, invalidate all
      logWarn("Checksum mismatch detected; invalidating all attestation caches", {
        conflictType,
      });
      await invalidateAllAttestationCaches();
      break;

    case "stale_cache":
      // Stale cache was detected: invalidate single hash
      if (recordHash) {
        await invalidateAttestationCache(recordHash, "reorg_detected");
      }
      break;

    case "address_mismatch":
    case "duplicate_payout":
      // Payout-side conflicts: don't affect attestation cache
      // (different state machines, no correlation)
      break;

    default:
      logWarn("Unknown conflict type, no cache invalidation", { conflictType });
  }
}

/**
 * On-demand refresh: force a fresh Soroban RPC read for a record hash,
 * bypassing any cache. Used by manual verification endpoints or diagnostics.
 *
 * Note: This doesn't invalidate the cache itself, but signals that a
 * fresh read is needed. Callers should handle cache bypass in their logic.
 */
export async function requestFreshAttestationRead(recordHash: string): Promise<void> {
  try {
    // Invalidate to ensure next read goes to RPC
    await invalidateAttestationCache(recordHash, "new_attestation");
    logInfo("Fresh attestation read requested", { recordHash });
  } catch (error) {
    logError("Failed to request fresh attestation read", error, { recordHash });
  }
}
