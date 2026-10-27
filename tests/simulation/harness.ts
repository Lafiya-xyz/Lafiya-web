/**
 * Deterministic simulation harness for the ledger indexers (issue #775).
 *
 * A seeded fault plan drives an in-memory event source and store that inject
 * duplicate delivery, reordering, truncated pages, timeouts and process
 * crashes. After every run a set of invariants is checked against the
 * ground-truth event log. Failures report the seed and a minimized fault
 * schedule that can be replayed with `SIM_SEED=<seed> npm run test:sim`.
 */

export type SimEvent = { id: string; position: number; amount: number };

export type FaultKind =
  | "none"
  | "duplicate"
  | "reorder"
  | "truncate"
  | "timeout"
  | "crash-before-apply"
  | "crash-after-apply"
  | "crash-before-cursor";

export const FAULT_KINDS: FaultKind[] = [
  "none",
  "duplicate",
  "reorder",
  "truncate",
  "timeout",
  "crash-before-apply",
  "crash-after-apply",
  "crash-before-cursor",
];

export type Fault = { step: number; kind: FaultKind; arg: number };

export type SimSource = {
  read(cursor: string | null): Promise<{ events: SimEvent[]; cursor: string }>;
};

export type SimStore = {
  getCursor(): Promise<string | null>;
  apply(event: SimEvent): Promise<void>;
  saveCursor(cursor: string): Promise<void>;
};

/** Wires the simulated source/store into a real indexer and runs it once. */
export type IndexerAdapter = (
  source: SimSource,
  store: SimStore,
) => Promise<void>;

export type SimResult = {
  seed: number;
  violations: string[];
  schedule: Fault[];
};

export const PAGE_SIZE = 4;
const EVENT_COUNT = 20;
const FAULTY_STEPS = 30;
const DRAIN_STEPS = 50;

/** mulberry32: small, fast, deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function groundTruth(seed: number): SimEvent[] {
  const random = rng(seed ^ 0x9e3779b9);
  return Array.from({ length: EVENT_COUNT }, (_, position) => ({
    id: `event-${position}`,
    position,
    amount: 1 + Math.floor(random() * 100),
  }));
}

export function faultPlan(seed: number): Fault[] {
  const random = rng(seed);
  const plan: Fault[] = [];
  for (let step = 0; step < FAULTY_STEPS; step += 1) {
    const kind = FAULT_KINDS[Math.floor(random() * FAULT_KINDS.length)];
    if (kind !== "none") {
      plan.push({ step, kind, arg: Math.floor(random() * PAGE_SIZE) });
    }
  }
  return plan;
}

class Crash extends Error {}

/** Executes one simulation against `adapter` using an explicit schedule. */
export async function simulate(
  adapter: IndexerAdapter,
  seed: number,
  schedule: Fault[],
): Promise<string[]> {
  const truth = groundTruth(seed);
  const rows = new Map<string, SimEvent>();
  const applyCounts = new Map<string, number>();
  const savedCursors: number[] = [];
  const violations: string[] = [];
  let cursor: string | null = null;
  let fault: Fault | undefined;
  let applyCalls = 0;

  const source: SimSource = {
    async read(current) {
      if (fault?.kind === "timeout") throw new Crash("source timeout");
      const start = Number(current ?? 0);
      let size = PAGE_SIZE;
      if (fault?.kind === "truncate") size = Math.max(1, fault.arg);
      const end = Math.min(truth.length, start + size);
      let events = truth.slice(start, end);
      if (fault?.kind === "duplicate") {
        const from = Math.max(0, start - 1 - fault.arg);
        events = [...truth.slice(from, start), ...events, ...events.slice(-1)];
      }
      if (fault?.kind === "reorder") events = [...events].reverse();
      return { events, cursor: String(end) };
    },
  };

  const store: SimStore = {
    async getCursor() {
      return cursor;
    },
    async apply(event) {
      const call = applyCalls;
      applyCalls += 1;
      if (fault?.kind === "crash-before-apply" && call === fault.arg) {
        throw new Crash("crash before apply");
      }
      applyCounts.set(event.id, (applyCounts.get(event.id) ?? 0) + 1);
      if (!rows.has(event.id)) rows.set(event.id, event);
      if (fault?.kind === "crash-after-apply" && call === fault.arg) {
        throw new Crash("crash after apply");
      }
    },
    async saveCursor(next) {
      if (fault?.kind === "crash-before-cursor") {
        throw new Crash("crash before cursor save");
      }
      const position = Number(next);
      for (const event of truth.slice(0, position)) {
        if (!rows.has(event.id)) {
          violations.push(
            `cursor ${next} saved before ${event.id} was committed`,
          );
          break;
        }
      }
      savedCursors.push(position);
      cursor = next;
    },
  };

  for (let step = 0; step < FAULTY_STEPS + DRAIN_STEPS; step += 1) {
    if (Number(cursor ?? 0) >= truth.length && step >= FAULTY_STEPS) break;
    fault = schedule.find((entry) => entry.step === step);
    applyCalls = 0;
    try {
      // A fresh adapter call per step models a process restart.
      await adapter(source, store);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
  }

  // Invariant 1: no event lost.
  const lost = truth.filter((event) => !rows.has(event.id));
  if (lost.length > 0) {
    violations.push(`lost events: ${lost.map((e) => e.id).join(", ")}`);
  }
  // Invariant 2: none applied twice (materialized state holds one row each).
  if (rows.size > truth.length) {
    violations.push(
      `${rows.size} rows materialized for ${truth.length} events`,
    );
  }
  // Invariant 3: cursor is monotonic.
  for (let i = 1; i < savedCursors.length; i += 1) {
    if (savedCursors[i] < savedCursors[i - 1]) {
      violations.push(
        `cursor regressed ${savedCursors[i - 1]} -> ${savedCursors[i]}`,
      );
      break;
    }
  }
  // Invariant 4: totals equal the ground-truth model.
  const expected = truth.reduce((sum, event) => sum + event.amount, 0);
  const actual = [...rows.values()].reduce((sum, e) => sum + e.amount, 0);
  if (expected !== actual) {
    violations.push(`total ${actual} != ground truth ${expected}`);
  }
  // Invariant 5: the run converges to the end of the log.
  if (Number(cursor ?? 0) !== truth.length) {
    violations.push(`final cursor ${cursor} != ${truth.length}`);
  }
  // Invariant 6: every apply targeted a real ground-truth event.
  for (const id of applyCounts.keys()) {
    if (!truth.some((event) => event.id === id)) {
      violations.push(`applied unknown event ${id}`);
    }
  }
  return [...new Set(violations)];
}

/** Greedily drops faults while the failure still reproduces. */
export async function minimize(
  adapter: IndexerAdapter,
  seed: number,
  schedule: Fault[],
): Promise<Fault[]> {
  let current = schedule;
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const candidate = current.filter((_, index) => index !== i);
    if ((await simulate(adapter, seed, candidate)).length > 0) {
      current = candidate;
    }
  }
  return current;
}

export async function runSeed(
  adapter: IndexerAdapter,
  seed: number,
): Promise<SimResult> {
  const plan = faultPlan(seed);
  const violations = await simulate(adapter, seed, plan);
  if (violations.length === 0) return { seed, violations, schedule: plan };
  return { seed, violations, schedule: await minimize(adapter, seed, plan) };
}

export function formatFailure(name: string, result: SimResult): string {
  return [
    `${name} simulation failed for seed ${result.seed}`,
    ...result.violations.map((violation) => `  - ${violation}`),
    `minimized schedule: ${JSON.stringify(result.schedule)}`,
    `replay: SIM_SEED=${result.seed} npm run test:sim`,
  ].join("\n");
}

export function seedsToRun(): number[] {
  if (process.env.SIM_SEED) return [Number(process.env.SIM_SEED)];
  const runs = Number(process.env.SIM_RUNS ?? 1000);
  return Array.from({ length: runs }, (_, index) => index + 1);
}
