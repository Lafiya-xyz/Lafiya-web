import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";

import {
  lockoutSeconds,
  stepFrequency,
  stepRateLimit,
  type FrequencyAction,
  type FrequencyModelState,
  type RateLimitAction,
  type RateLimitModelState,
} from "@/lib/rate-limit-model";
import type { Database } from "@/lib/supabase/types";

import { adminClient } from "./helpers/testUser";

/**
 * Issue #783: model-check rate_limit_record_failure() and
 * frequency_limit_check_and_increment() against the pure reference models in
 * lib/rate-limit-model.ts. Each run drives the real SQL through seeded random
 * action sequences and compares the database state after every step.
 *
 * Clock changes are simulated by backdating the row's timestamps through the
 * service-role client (the SQL always uses now(), see
 * purge-expired-limits.test.ts for the same technique).
 *
 * Known divergences: none. Behaviour that may look like one but is intended:
 * an expired lockout does not reset the failure counter -- only a success
 * does -- so the next failure after a long idle period still escalates.
 */

const RUNS = Number(process.env.RATE_LIMIT_MODEL_RUNS ?? 1000);
const SEED = Number(process.env.RATE_LIMIT_MODEL_SEED ?? 783);
const MAX_STEPS = 12;
const FREQUENCY_MAX = 3;
const FREQUENCY_WINDOW = 60;
const CONCURRENCY = 20;

// mulberry32: small, seeded, reproducible PRNG.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rateKeys = new Set<string>();
const frequencyKeys = new Set<string>();

function testKey(set: Set<string>, label: string): string {
  const key = `test:model:${label}:${crypto.randomUUID()}`;
  set.add(key);
  return key;
}

afterEach(async () => {
  await Promise.all([
    ...Array.from(rateKeys, (key) =>
      adminClient.from("rate_limits").delete().eq("key", key),
    ),
    ...Array.from(frequencyKeys, (key) =>
      adminClient.from("frequency_limits").delete().eq("key", key),
    ),
  ]);
  rateKeys.clear();
  frequencyKeys.clear();
});

const shift = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) - seconds * 1000).toISOString();

function randomRateAction(rand: () => number): RateLimitAction {
  const r = rand();
  if (r < 0.7) return { kind: "failure" };
  if (r < 0.8) return { kind: "success" };
  return { kind: "advance", seconds: Math.floor(rand() * 1200) };
}

function randomFrequencyAction(rand: () => number): FrequencyAction {
  if (rand() < 0.75) return { kind: "hit" };
  // Bias toward the window boundary, where off-by-one bugs live.
  const boundary = [
    FREQUENCY_WINDOW - 1,
    FREQUENCY_WINDOW,
    FREQUENCY_WINDOW + 1,
  ];
  return {
    kind: "advance",
    seconds:
      rand() < 0.5
        ? boundary[Math.floor(rand() * boundary.length)]!
        : Math.floor(rand() * 30),
  };
}

async function runRateSequence(rand: () => number, run: number) {
  const key = testKey(rateKeys, `rate:${run}`);
  let model: RateLimitModelState = { attempts: null };
  const steps = 1 + Math.floor(rand() * MAX_STEPS);

  for (let step = 0; step < steps; step++) {
    const action = randomRateAction(rand);
    model = stepRateLimit(model, action);
    const context = `seed=${SEED} run=${run} step=${step} ${JSON.stringify(action)}`;

    if (action.kind === "failure") {
      const { error } = await adminClient.rpc("rate_limit_record_failure", {
        p_key: key,
      });
      expect(error, context).toBeNull();
    } else if (action.kind === "success") {
      await adminClient.from("rate_limits").delete().eq("key", key);
    } else {
      const { data } = await adminClient
        .from("rate_limits")
        .select("blocked_until, updated_at")
        .eq("key", key)
        .maybeSingle();
      if (data) {
        await adminClient
          .from("rate_limits")
          .update({
            updated_at: shift(data.updated_at, action.seconds),
            blocked_until: data.blocked_until
              ? shift(data.blocked_until, action.seconds)
              : null,
          })
          .eq("key", key);
      }
    }

    const { data: row } = await adminClient
      .from("rate_limits")
      .select("attempts, blocked_until, updated_at")
      .eq("key", key)
      .maybeSingle();

    if (model.attempts === null) {
      expect(row, context).toBeNull();
      continue;
    }
    expect(row?.attempts, context).toBe(model.attempts);
    const expected = lockoutSeconds(model.attempts);
    if (expected === null) {
      expect(row?.blocked_until, context).toBeNull();
    } else {
      // blocked_until and updated_at are both now() from the same statement
      // (and shifted together on clock changes), so their gap is exact.
      const actual =
        (Date.parse(row!.blocked_until!) - Date.parse(row!.updated_at)) / 1000;
      expect(actual, context).toBeCloseTo(expected, 3);
    }
  }
}

async function runFrequencySequence(rand: () => number, run: number) {
  const key = testKey(frequencyKeys, `freq:${run}`);
  let model: FrequencyModelState = { elapsed: null, count: 0 };
  const steps = 1 + Math.floor(rand() * MAX_STEPS);

  for (let step = 0; step < steps; step++) {
    const action = randomFrequencyAction(rand);
    const { state, result } = stepFrequency(
      model,
      action,
      FREQUENCY_MAX,
      FREQUENCY_WINDOW,
    );
    model = state;
    const context = `seed=${SEED} run=${run} step=${step} ${JSON.stringify(action)}`;

    if (action.kind === "advance") {
      const { data } = await adminClient
        .from("frequency_limits")
        .select("window_start")
        .eq("key", key)
        .maybeSingle();
      if (data) {
        await adminClient
          .from("frequency_limits")
          .update({ window_start: shift(data.window_start, action.seconds) })
          .eq("key", key);
      }
      continue;
    }

    const { data, error } = await adminClient.rpc(
      "frequency_limit_check_and_increment",
      {
        p_key: key,
        p_max_count: FREQUENCY_MAX,
        p_window_seconds: FREQUENCY_WINDOW,
      },
    );
    expect(error, context).toBeNull();
    const actual = Array.isArray(data) ? data[0] : data;
    expect(actual?.allowed, context).toBe(result!.allowed);
    expect(actual?.count, context).toBe(result!.count);
    // Real wall-clock time also passes between steps (well under a second),
    // so the ceil()'d hint may legitimately be one second lower.
    expect(
      result!.retryAfterSeconds - (actual?.retry_after_seconds ?? -1),
      context,
    ).toBeGreaterThanOrEqual(0);
    expect(
      result!.retryAfterSeconds - (actual?.retry_after_seconds ?? -1),
      context,
    ).toBeLessThanOrEqual(1);
  }
}

function newServiceRoleClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

describe("rate_limit_record_failure model check", () => {
  it(`agrees with the reference model over ${RUNS} random sequences`, async () => {
    const rand = prng(SEED);
    for (let run = 0; run < RUNS; run++) {
      await runRateSequence(rand, run);
    }
  }, 600_000);

  it("never loses an increment under concurrent failures on one key", async () => {
    const key = testKey(rateKeys, "rate:concurrent");
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        newServiceRoleClient().rpc("rate_limit_record_failure", { p_key: key }),
      ),
    );
    expect(results.every((r) => r.error === null)).toBe(true);

    const { data } = await adminClient
      .from("rate_limits")
      .select("attempts, blocked_until, updated_at")
      .eq("key", key)
      .single();
    expect(data?.attempts).toBe(CONCURRENCY);
    expect(
      (Date.parse(data!.blocked_until!) - Date.parse(data!.updated_at)) / 1000,
    ).toBeCloseTo(lockoutSeconds(CONCURRENCY)!, 3);
  });
});

describe("frequency_limit_check_and_increment model check", () => {
  it(`agrees with the reference model over ${RUNS} random sequences`, async () => {
    const rand = prng(SEED + 1);
    for (let run = 0; run < RUNS; run++) {
      await runFrequencySequence(rand, run);
    }
  }, 600_000);

  it("never loses an increment under concurrent hits on one key", async () => {
    const key = testKey(frequencyKeys, "freq:concurrent");
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        newServiceRoleClient().rpc("frequency_limit_check_and_increment", {
          p_key: key,
          p_max_count: FREQUENCY_MAX,
          p_window_seconds: FREQUENCY_WINDOW,
        }),
      ),
    );
    expect(results.every((r) => r.error === null)).toBe(true);
    const allowed = results.filter((r) => {
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return row?.allowed;
    });
    expect(allowed).toHaveLength(FREQUENCY_MAX);

    const { data } = await adminClient
      .from("frequency_limits")
      .select("count")
      .eq("key", key)
      .single();
    expect(data?.count).toBe(CONCURRENCY);
  });
});
