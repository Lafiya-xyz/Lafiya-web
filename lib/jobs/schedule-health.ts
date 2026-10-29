import schedules from "@/lib/ops/schedules.json";
import { logWarn } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Missed-run detection for scheduled jobs (Issue #693). Each job writes a
 * heartbeat row (`job_leases.last_success_at`) on success — leased jobs via
 * `release_job_lease`, others via `record_job_success`. The readiness probe
 * reports each manifest job's last-success age and flags it `stale` once it
 * exceeds `maxStalenessSeconds`.
 */
export interface JobRunHealth {
  lastSuccessAgeSeconds: number | null;
  status: "ok" | "stale" | "never_run" | "unknown";
}

type UntypedClient = {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ error: { message: string } | null }>;
  from(table: string): {
    select(columns: string): PromiseLike<{
      data: Array<{ job_name: string; last_success_at: string | null }> | null;
      error: { message: string } | null;
    }>;
  };
};

function client(): UntypedClient {
  return createAdminClient({
    purpose: "job-lease",
  }) as unknown as UntypedClient;
}

/** Record a successful run for a job that does not hold a lease. Never throws. */
export async function recordJobSuccess(jobName: string): Promise<void> {
  try {
    const { error } = await client().rpc("record_job_success", {
      p_job_name: jobName,
    });
    if (error)
      logWarn("job_success_record_failed", { jobName, message: error.message });
  } catch (error) {
    logWarn("job_success_record_failed", { jobName, message: String(error) });
  }
}

export async function getScheduledJobHealth(): Promise<
  Record<string, JobRunHealth>
> {
  const jobs = schedules.jobs.filter(
    (job): job is typeof job & { maxStalenessSeconds: number } =>
      !("manualOnly" in job && job.manualOnly) && "maxStalenessSeconds" in job,
  );
  let rows: Map<string, string | null> | null = null;
  try {
    const { data, error } = await client()
      .from("job_leases")
      .select("job_name, last_success_at");
    if (!error && data)
      rows = new Map(data.map((row) => [row.job_name, row.last_success_at]));
  } catch {
    rows = null;
  }

  const now = Date.now();
  return Object.fromEntries(
    jobs.map((job): [string, JobRunHealth] => {
      if (!rows)
        return [job.name, { lastSuccessAgeSeconds: null, status: "unknown" }];
      const last = rows.get(job.name);
      if (!last)
        return [job.name, { lastSuccessAgeSeconds: null, status: "never_run" }];
      const age = Math.max(0, Math.round((now - Date.parse(last)) / 1000));
      return [
        job.name,
        {
          lastSuccessAgeSeconds: age,
          status: age > job.maxStalenessSeconds ? "stale" : "ok",
        },
      ];
    }),
  );
}
