/**
 * Per-provider circuit breaker (issue #625).
 *
 * Each provider gets its own CircuitBreaker instance.  After
 * `failureThreshold` consecutive failures the circuit opens and the provider
 * is skipped for `resetTimeoutMs`.  The circuit moves to half-open after the
 * cooldown and allows one probe request; a success closes it again.
 *
 * This is an in-process implementation suitable for a single Node.js worker.
 * For multi-replica deployments, replace the in-memory state with a Redis
 * counter (same API, different persistence layer).
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  }

  isAvailable(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half-open") return true;
    // open — check whether the cooldown has elapsed
    if (this.openedAt !== null && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half-open";
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState {
    // Refresh half-open transition on read.
    this.isAvailable();
    return this.state;
  }
}
