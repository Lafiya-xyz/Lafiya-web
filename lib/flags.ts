/**
 * Server-evaluated feature flags and kill switches.
 *
 * Flags are stored in the `feature_flags` table and cached in-memory for 30s
 * so a kill switch flipped by an operator takes effect within 60s across
 * instances without a redeploy.
 *
 * Off-path behaviour for each gated subsystem:
 *  - attestation_lookup: attestation lookups return null; callers must treat
 *    the attestation as unknown rather than trusted.
 *  - payouts: payout requests are rejected with a retryable error; no funds move.
 *  - uploads: uploads are rejected with a retryable error; no bytes are stored.
 *  - capability_sharing: capability share links are not issued or resolved.
 *
 * Privacy: only a hashed user id is used for bucketing. No PHI or capability
 * tokens are read, logged, or sent anywhere by this module.
 */

import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type FlagKey =
  | 'attestation_lookup'
  | 'payouts'
  | 'uploads'
  | 'capability_sharing';

export interface FlagState {
  key: FlagKey;
  enabled: boolean;
  rolloutPct: number;
  environments: string[];
}

/** Fail-safe default per flag: when the flag is missing or the store is
 * unreachable we fall back to this value. Risky subsystems default to off so
 * an outage cannot silently enable them. */
export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
  attestation_lookup: false,
  payouts: false,
  uploads: false,
  capability_sharing: false,
};

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  state: FlagState;
  expiresAt: number;
}

const cache = new Map<FlagKey, CacheEntry>();

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

function currentEnvironment(): string {
  return process.env.NEXT_PUBLIC_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production';
}

/** Deterministic bucketing: hash the user id and map to 0-99. */
export function bucketForUser(userId: string): number {
  const digest = createHash('sha256').update(userId).digest();
  // Use the first 4 bytes as an unsigned integer, then mod 100.
  const value = digest.readUInt32BE(0);
  return value % 100;
}

/**
 * Evaluate a flag for a given user. Returns false when the flag is disabled,
 * when the environment is not targeted, or when the user falls outside the
 * rollout percentage. Falls back to FLAG_DEFAULTS on any error.
 */
export async function isEnabled(key: FlagKey, userId?: string): Promise<boolean> {
  const state = await getFlagState(key);
  if (!state) return FLAG_DEFAULTS[key];
  if (!state.enabled) return false;
  if (!state.environments.includes(currentEnvironment())) return false;
  if (state.rolloutPct >= 100) return true;
  if (state.rolloutPct <= 0) return false;
  if (!userId) return false;
  return bucketForUser(userId) < state.rolloutPct;
}

/** Read the raw flag state, using the 30s cache. */
export async function getFlagState(key: FlagKey): Promise<FlagState | null> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.state;

  const supabase = getClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('feature_flags')
      .select('key, enabled, rollout_pct, environments')
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    const state: FlagState = {
      key: data.key as FlagKey,
      enabled: Boolean(data.enabled),
      rolloutPct: Number(data.rollout_pct ?? 0),
      environments: (data.environments as string[]) ?? [],
    };
    cache.set(key, { state, expiresAt: now + CACHE_TTL_MS });
    return state;
  } catch {
    return null;
  }
}

/** Snapshot of flag state for readiness reporting (no per-user bucketing). */
export async function getFlagSnapshot(): Promise<Record<string, { enabled: boolean; rolloutPct: number }>> {
  const keys: FlagKey[] = ['attestation_lookup', 'payouts', 'uploads', 'capability_sharing'];
  const snapshot: Record<string, { enabled: boolean; rolloutPct: number }> = {};
  for (const key of keys) {
    const state = await getFlagState(key);
    snapshot[key] = {
      enabled: state ? state.enabled : FLAG_DEFAULTS[key],
      rolloutPct: state ? state.rolloutPct : 0,
    };
  }
  return snapshot;
}

/** Test helper: clear the in-memory cache. */
export function clearFlagCache(): void {
  cache.clear();
}
