/**
 * End-to-end freshness instrumentation (issue #950).
 *
 * Measures the latency between the moment a patient's record was last edited
 * (`record_updated_at`, maintained by the `profiles_set_updated_at` trigger)
 * and the moment a responder-visible surface served that record. One
 * histogram per surface, so a regression on a single delivery path (wallet
 * push, offline envelope, short link) is visible on its own.
 *
 * PHI-safe: only a surface name, a coarse outcome, and a duration are ever
 * emitted. No card id, capability token, record hash, or patient field.
 *
 * SLOs and alerting rules: docs/operations/freshness-slo.md.
 */
import { logInfo, logWarn } from "@/lib/logging/logger";

export const FRESHNESS_SURFACES = [
  "card_render",
  "envelope_refresh",
  "wallet_pass_update",
  "offline_cache",
  "short_link",
] as const;

export type FreshnessSurface = (typeof FRESHNESS_SURFACES)[number];

/** Upper bounds (ms) of each histogram bucket; the last bucket is +Inf. */
export const FRESHNESS_BUCKETS_MS = [
  1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 21_600_000,
] as const;

/** Per-surface freshness SLO: fraction of updates visible within `targetMs`. */
export const FRESHNESS_SLOS: Record<
  FreshnessSurface,
  { targetMs: number; objective: number }
> = {
  card_render: { targetMs: 60_000, objective: 0.99 },
  envelope_refresh: { targetMs: 300_000, objective: 0.99 },
  wallet_pass_update: { targetMs: 900_000, objective: 0.95 },
  offline_cache: { targetMs: 300_000, objective: 0.95 },
  short_link: { targetMs: 60_000, objective: 0.99 },
};

export interface FreshnessHistogram {
  surface: FreshnessSurface;
  /** Cumulative bucket counts, aligned with FRESHNESS_BUCKETS_MS (+Inf last). */
  buckets: number[];
  count: number;
  sumMs: number;
  /** Observations that breached the surface SLO target. */
  breaches: number;
}

const histograms = new Map<FreshnessSurface, FreshnessHistogram>();

function histogramFor(surface: FreshnessSurface): FreshnessHistogram {
  let h = histograms.get(surface);
  if (!h) {
    h = {
      surface,
      buckets: new Array(FRESHNESS_BUCKETS_MS.length + 1).fill(0),
      count: 0,
      sumMs: 0,
      breaches: 0,
    };
    histograms.set(surface, h);
  }
  return h;
}

/**
 * Latency in ms between a record edit and the surface serving it, or null
 * when either timestamp is missing/unparseable or the edit is in the future
 * (clock skew) — such samples are dropped rather than recorded as negative.
 */
export function freshnessLatencyMs(
  recordUpdatedAt: string | null | undefined,
  servedAt: number = Date.now(),
): number | null {
  if (!recordUpdatedAt) return null;
  const editedAt = Date.parse(recordUpdatedAt);
  if (Number.isNaN(editedAt)) return null;
  const latency = servedAt - editedAt;
  return latency < 0 ? null : latency;
}

/**
 * Record one freshness observation for `surface`. Emits a structured
 * `freshness_observation` log line (the histogram sink) and a
 * `freshness_slo_breach` warning when the sample exceeds the SLO target.
 */
export function observeFreshness(
  surface: FreshnessSurface,
  latencyMs: number,
): void {
  const h = histogramFor(surface);
  h.count++;
  h.sumMs += latencyMs;
  const idx = FRESHNESS_BUCKETS_MS.findIndex((bound) => latencyMs <= bound);
  const bucketIndex = idx === -1 ? FRESHNESS_BUCKETS_MS.length : idx;
  for (let i = bucketIndex; i < h.buckets.length; i++) h.buckets[i]++;

  const slo = FRESHNESS_SLOS[surface];
  const breached = latencyMs > slo.targetMs;
  if (breached) h.breaches++;

  logInfo("freshness_observation", {
    surface,
    latency_ms: latencyMs,
    slo_target_ms: slo.targetMs,
    breached,
  });
  if (breached) {
    logWarn("freshness_slo_breach", {
      surface,
      latency_ms: latencyMs,
      slo_target_ms: slo.targetMs,
    });
  }
}

/** Convenience wrapper: derive the latency from `record_updated_at` and record it. */
export function observeRecordFreshness(
  surface: FreshnessSurface,
  recordUpdatedAt: string | null | undefined,
  servedAt: number = Date.now(),
): void {
  const latency = freshnessLatencyMs(recordUpdatedAt, servedAt);
  if (latency === null) return;
  observeFreshness(surface, latency);
}

/** Snapshot of every histogram, for the readiness probe / operator CLI. */
export function freshnessSnapshot(): FreshnessHistogram[] {
  return FRESHNESS_SURFACES.map((surface) => {
    const h = histogramFor(surface);
    return { ...h, buckets: [...h.buckets] };
  });
}

/** Test/operator helper: drop all accumulated observations. */
export function resetFreshnessHistograms(): void {
  histograms.clear();
}
