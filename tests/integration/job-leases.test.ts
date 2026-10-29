import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { runWithLease, SupabaseJobLeaseStore } from "@/lib/jobs/lease";

// Issue #694: lease semantics against local Supabase.
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function store() {
  return new SupabaseJobLeaseStore(admin as never);
}

describe("job_leases", () => {
  it("never lets two concurrent invocations hold the same job window", async () => {
    const jobName = `test-concurrent-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store().acquire(jobName, `runner-${i}`, 60),
      ),
    );
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });

  it("takes over a killed runner's lease after its TTL and logs the takeover", async () => {
    const jobName = `test-takeover-${crypto.randomUUID()}`;
    // A runner that "crashes": acquires a 1s lease and never releases it.
    expect((await store().acquire(jobName, "crashed", 1)).acquired).toBe(true);
    expect((await store().acquire(jobName, "next", 60)).acquired).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const ran = await runWithLease(jobName, async () => "ok", {
      store: store(),
      holder: "next",
    });
    expect(ran).toBe("ok");

    const { data } = await admin
      .from("job_leases" as never)
      .select("holder, takeover_count, last_success_at")
      .eq("job_name", jobName)
      .single();
    const row = data as {
      holder: string | null;
      takeover_count: number;
      last_success_at: string | null;
    } | null;
    expect(row?.holder).toBeNull();
    expect(row?.takeover_count).toBeGreaterThanOrEqual(1);
    expect(row?.last_success_at).not.toBeNull();
  });
});
