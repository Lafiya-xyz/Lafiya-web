/**
 * Keyed, in-process singleflight (Issue #692).
 *
 * Concurrent calls for the same key share one in-flight upstream call, so a
 * card scanned in bulk triggers one Soroban read / card RPC per instance
 * rather than one per request.
 *
 * Correctness rules:
 * - Only results that are identical for every caller may be coalesced. Keys
 *   MUST encode the full authorization context (callers coalesce public,
 *   already-cacheable reads only — never a signed-in viewer's lookup).
 * - Entries live only while the leader call is in flight (bounded by
 *   `ttlMs`). A rejected leader propagates the same error to its followers,
 *   then the key is cleared so the next call starts fresh.
 * - The map is bounded by `maxKeys`; when full, the oldest entry is evicted
 *   (its followers still settle; only new callers stop joining it).
 */
export interface SingleflightOptions {
  maxKeys: number;
  ttlMs: number;
}

export interface SingleflightMetrics {
  /** Calls that started an upstream request. */
  originated: number;
  /** Calls that joined an existing in-flight request. */
  coalesced: number;
}

interface Flight {
  promise: Promise<unknown>;
  startedAt: number;
}

export class Singleflight {
  private readonly flights = new Map<string, Flight>();
  readonly metrics: SingleflightMetrics = { originated: 0, coalesced: 0 };

  constructor(private readonly options: SingleflightOptions) {}

  do<T>(key: string, fn: () => PromiseLike<T>): Promise<T> {
    const now = Date.now();
    const existing = this.flights.get(key);
    if (existing && now - existing.startedAt < this.options.ttlMs) {
      this.metrics.coalesced++;
      return existing.promise as Promise<T>;
    }
    if (existing) this.flights.delete(key);

    while (this.flights.size >= this.options.maxKeys) {
      const oldest = this.flights.keys().next().value;
      if (oldest === undefined) break;
      this.flights.delete(oldest);
    }

    this.metrics.originated++;
    const promise: Promise<T> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.flights.get(key)?.promise === promise)
          this.flights.delete(key);
      });
    this.flights.set(key, { promise, startedAt: now });
    return promise;
  }

  /** Number of keys currently tracked (for tests/monitoring). */
  get size(): number {
    return this.flights.size;
  }
}
