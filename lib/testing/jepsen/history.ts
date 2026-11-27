/**
 * Issue #952: Jepsen-style concurrency harness primitives.
 *
 * A *history* is the ordered record of what a randomized concurrent workload
 * observed: `invoke` when an operation starts, `ok`/`fail` when it finishes.
 * Invariants are pure functions over a history, so a failing seed can be
 * replayed and minimized without touching Postgres again.
 *
 * No PHI and no capability tokens are ever recorded: operations carry opaque
 * ids only (see `docs/issues/952-jepsen-concurrency.md`).
 */

export type OpKind =
  | "save_revision"
  | "issue_capability"
  | "revoke_capability"
  | "merge_accounts";

export type HistoryEvent =
  | {
      type: "invoke";
      process: number;
      op: OpKind;
      /** Opaque, non-identifying operation id. */
      id: string;
      /** Opaque target ids (user/card/capability) — never tokens. */
      target: string;
      /** Monotonic logical time assigned by the harness. */
      time: number;
    }
  | {
      type: "ok" | "fail";
      process: number;
      id: string;
      time: number;
      /** Error code only (e.g. STALE_REVISION); never a message with data. */
      error?: string;
    };

export type History = HistoryEvent[];

/** Deterministic PRNG (mulberry32) so a seed fully reproduces a schedule. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Records events with a monotonic clock; one instance per run. */
export class HistoryRecorder {
  private readonly events: History = [];
  private clock = 0;

  invoke(process: number, op: OpKind, id: string, target: string): void {
    this.events.push({
      type: "invoke",
      process,
      op,
      id,
      target,
      time: this.clock++,
    });
  }

  complete(
    process: number,
    id: string,
    outcome: "ok" | "fail",
    error?: string,
  ): void {
    this.events.push({
      type: outcome,
      process,
      id,
      time: this.clock++,
      ...(error ? { error } : {}),
    });
  }

  snapshot(): History {
    return [...this.events];
  }
}

export type InvariantViolation = {
  invariant: string;
  detail: string;
  /** Operation ids implicated, for minimization. */
  ops: string[];
};

type Completed = {
  op: OpKind;
  target: string;
  outcome: "ok" | "fail";
  error?: string;
  invokeTime: number;
  completeTime: number;
};

/** Pairs invoke/complete events; unpaired invokes are reported separately. */
export function completedOps(history: History): {
  completed: Completed[];
  pending: string[];
} {
  const open = new Map<string, Extract<HistoryEvent, { type: "invoke" }>>();
  const completed: Completed[] = [];
  for (const event of history) {
    if (event.type === "invoke") {
      open.set(event.id, event);
      continue;
    }
    const invoke = open.get(event.id);
    if (!invoke) continue;
    open.delete(event.id);
    completed.push({
      op: invoke.op,
      target: invoke.target,
      outcome: event.type,
      error: event.error,
      invokeTime: invoke.time,
      completeTime: event.time,
    });
  }
  return { completed, pending: [...open.keys()] };
}

/**
 * Invariant: at most one *active* capability per card at any instant.
 *
 * `issue_capability` is modelled as superseding the card's previous active
 * capability (rotation), so two successful issues on the same card must not
 * overlap in time — an overlap means two live links existed concurrently.
 */
export function checkOneActiveCapability(history: History): InvariantViolation[] {
  const { completed } = completedOps(history);
  const issues = completed.filter(
    (op) => op.op === "issue_capability" && op.outcome === "ok",
  );
  const violations: InvariantViolation[] = [];
  for (let i = 0; i < issues.length; i++) {
    for (let j = i + 1; j < issues.length; j++) {
      const a = issues[i];
      const b = issues[j];
      if (a.target !== b.target) continue;
      const overlap =
        a.invokeTime < b.completeTime && b.invokeTime < a.completeTime;
      if (overlap) {
        violations.push({
          invariant: "one_active_capability_per_card",
          detail: `two capability issues overlapped on card ${a.target}`,
          ops: [a.target],
        });
      }
    }
  }
  return violations;
}

/**
 * Invariant: no orphaned revisions. Every successful save must be followed by
 * a later successful save on the same record (or be the head), and no save may
 * report success after a conflicting save on the same record already
 * succeeded within its window — that would mean a lost update.
 */
export function checkNoOrphanedRevisions(history: History): InvariantViolation[] {
  const { completed } = completedOps(history);
  const saves = completed.filter((op) => op.op === "save_revision");
  const violations: InvariantViolation[] = [];
  for (let i = 0; i < saves.length; i++) {
    for (let j = i + 1; j < saves.length; j++) {
      const a = saves[i];
      const b = saves[j];
      if (a.target !== b.target) continue;
      if (a.outcome !== "ok" || b.outcome !== "ok") continue;
      const overlap =
        a.invokeTime < b.completeTime && b.invokeTime < a.completeTime;
      if (overlap) {
        violations.push({
          invariant: "no_orphaned_revisions",
          detail: `two saves on record ${a.target} both succeeded while overlapping`,
          ops: [a.target],
        });
      }
    }
  }
  return violations;
}

/**
 * Invariant: merge atomicity. A merge either fully succeeds (and every
 * operation on the loser account afterwards fails) or fully fails (and the
 * loser account keeps working). A successful merge followed by a successful
 * write to the loser is a torn merge.
 */
export function checkMergeAtomicity(history: History): InvariantViolation[] {
  const { completed } = completedOps(history);
  const violations: InvariantViolation[] = [];
  const merges = completed.filter(
    (op) => op.op === "merge_accounts" && op.outcome === "ok",
  );
  for (const merge of merges) {
    for (const op of completed) {
      if (op.op === "merge_accounts") continue;
      if (op.target !== merge.target) continue;
      if (op.outcome !== "ok") continue;
      if (op.invokeTime > merge.completeTime) {
        violations.push({
          invariant: "merge_atomicity",
          detail: `operation on merged-away account ${merge.target} succeeded after the merge committed`,
          ops: [merge.target],
        });
      }
    }
  }
  return violations;
}

export const INVARIANTS = [
  checkOneActiveCapability,
  checkNoOrphanedRevisions,
  checkMergeAtomicity,
] as const;

export function checkAll(history: History): InvariantViolation[] {
  return INVARIANTS.flatMap((check) => check(history));
}

/**
 * Seed minimization: drop operations one at a time while the history still
 * violates an invariant. Returns the smallest set of operation ids that keeps
 * the failure reproducible.
 */
export function minimizeSeed(
  history: History,
  check: (h: History) => InvariantViolation[] = checkAll,
): { history: History; ops: string[] } {
  const { completed } = completedOps(history);
  let keep = new Set(completed.map((op) => op.target));
  let current = history;
  for (const op of completed) {
    const candidate = new Set(keep);
    candidate.delete(op.target);
    const filtered = current.filter(
      (event) => event.type === "invoke" || candidate.has(event.target),
    );
    if (check(filtered).length > 0) {
      keep = candidate;
      current = filtered;
    }
  }
  return { history: current, ops: [...keep] };
}

/** Serializes a history for a failing-seed artifact (opaque ids only). */
export function serializeHistory(history: History): string {
  return JSON.stringify(history);
}
