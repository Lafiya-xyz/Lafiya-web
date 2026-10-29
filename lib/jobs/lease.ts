import { randomUUID } from "node:crypto";

import type { LeaseRunner } from "@/lib/jobs/lease-runner";
import { logInfo, logWarn } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Leased job runner (Issue #694).
 *
 * Long-running jobs (payout indexing, verification indexing) acquire a
 * time-bound lease in `public.job_leases` before touching their cursor, renew
 * it with heartbeats while working, and release it when done. A crashed
 * runner's lease expires after its TTL and the next invocation takes it over
 * (logged as `job_lease.takeover`). The lease only gates *who* may run; cursor
 * semantics are owned entirely by the job itself.
 */
export interface JobLeaseStore {
  acquire(
    jobName: string,
    holder: string,
    ttlSeconds: number,
  ): Promise<{ acquired: boolean; tookOver: boolean }>;
  heartbeat(
    jobName: string,
    holder: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  release(jobName: string, holder: string, succeeded: boolean): Promise<void>;
  reapExpired(): Promise<string[]>;
}

/** Untyped view of the RPCs added in 20261028120000_job_leases.sql. */
type LeaseRpcClient = {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export class SupabaseJobLeaseStore implements JobLeaseStore {
  constructor(
    private readonly client: LeaseRpcClient = createAdminClient({
      purpose: "job-lease",
    }) as unknown as LeaseRpcClient,
  ) {}

  private async call<T>(
    fn: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data as T;
  }

  async acquire(jobName: string, holder: string, ttlSeconds: number) {
    const rows = await this.call<
      Array<{ acquired: boolean; took_over: boolean }>
    >("acquire_job_lease", {
      p_job_name: jobName,
      p_holder: holder,
      p_ttl_seconds: ttlSeconds,
    });
    const row = rows?.[0];
    return {
      acquired: Boolean(row?.acquired),
      tookOver: Boolean(row?.took_over),
    };
  }

  heartbeat(jobName: string, holder: string, ttlSeconds: number) {
    return this.call<boolean>("heartbeat_job_lease", {
      p_job_name: jobName,
      p_holder: holder,
      p_ttl_seconds: ttlSeconds,
    });
  }

  async release(jobName: string, holder: string, succeeded: boolean) {
    await this.call("release_job_lease", {
      p_job_name: jobName,
      p_holder: holder,
      p_succeeded: succeeded,
    });
  }

  async reapExpired() {
    return (await this.call<string[] | null>("reap_expired_job_leases")) ?? [];
  }
}

/** Lease metrics: lease-held duration and takeover count. */
export const jobLeaseMetrics = {
  takeovers: 0,
  lastHeldMs: {} as Record<string, number>,
};

export class JobLeaseHeldError extends Error {
  constructor(jobName: string) {
    super(`Job lease for ${jobName} is held by another runner`);
    this.name = "JobLeaseHeldError";
  }
}

export interface RunWithLeaseOptions {
  ttlSeconds?: number;
  store?: JobLeaseStore;
  holder?: string;
}

/**
 * Run `work` while holding the lease for `jobName`. Throws `JobLeaseHeldError`
 * when another live runner holds it, so two invocations never process the
 * same job window concurrently.
 */
export async function runWithLease<T>(
  jobName: string,
  work: () => Promise<T>,
  {
    ttlSeconds = 120,
    store = new SupabaseJobLeaseStore(),
    holder = randomUUID(),
  }: RunWithLeaseOptions = {},
): Promise<T> {
  for (const reaped of await store.reapExpired()) {
    jobLeaseMetrics.takeovers++;
    logWarn("job_lease.takeover", {
      jobName: reaped,
      reason: "reaped_expired",
    });
  }

  const { acquired, tookOver } = await store.acquire(
    jobName,
    holder,
    ttlSeconds,
  );
  if (!acquired) throw new JobLeaseHeldError(jobName);
  if (tookOver) {
    jobLeaseMetrics.takeovers++;
    logWarn("job_lease.takeover", { jobName, reason: "expired_lease" });
  }

  const startedAt = Date.now();
  const heartbeat = setInterval(
    () => {
      void store.heartbeat(jobName, holder, ttlSeconds).then((renewed) => {
        if (!renewed) logWarn("job_lease.heartbeat_lost", { jobName });
      });
    },
    Math.max(1000, (ttlSeconds * 1000) / 3),
  );

  let succeeded = false;
  try {
    const result = await work();
    succeeded = true;
    return result;
  } finally {
    clearInterval(heartbeat);
    const heldMs = Date.now() - startedAt;
    jobLeaseMetrics.lastHeldMs[jobName] = heldMs;
    logInfo("job_lease.released", { jobName, heldMs, succeeded });
    await store.release(jobName, holder, succeeded);
  }
}

/** Production runner backed by `public.job_leases`. */
export const leasedRunner: LeaseRunner = (jobName, work) =>
  runWithLease(jobName, work);
