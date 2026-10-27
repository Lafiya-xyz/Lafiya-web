/**
 * Age-of-majority handover for guardian-managed dependants (issue #769).
 *
 * Pure policy + state machine. Guardian access ends at local midnight of the
 * majority birthday in the dependant's jurisdiction time zone; a staged
 * handover (notify → claim/decline/timeout) decides what access, if any,
 * the guardian retains. Every transition appends a consent record.
 */

export type HandoverState =
  "not_eligible" | "notified" | "claimed" | "declined" | "timed_out";

export type GuardianAccess = "full" | "read_only" | "none";

export type ConsentRecord = {
  at: string;
  actor: "system" | "dependant";
  grantedBy: "guardian" | "dependant";
  guardianAccess: GuardianAccess;
  event: string;
};

export type Handover = {
  state: HandoverState;
  guardianAccess: GuardianAccess;
  consent: ConsentRecord[];
};

export type HandoverPolicy = {
  majorityAge: number;
  timeZone: string;
  claimWindowDays: number;
};

export const DEFAULT_HANDOVER_POLICY: HandoverPolicy = {
  majorityAge: 18,
  timeZone: "Africa/Lagos",
  claimWindowDays: 30,
};

function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Majority date (YYYY-MM-DD); Feb 29 births roll to Mar 1 in common years. */
export function majorityDate(dateOfBirth: string, majorityAge: number): string {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  const date = new Date(Date.UTC(y + majorityAge, m - 1, d));
  return date.toISOString().slice(0, 10);
}

/** True once the dependant has reached majority in the policy time zone. */
export function hasReachedMajority(
  dateOfBirth: string,
  now: Date,
  policy: HandoverPolicy = DEFAULT_HANDOVER_POLICY,
): boolean {
  return (
    localDate(now, policy.timeZone) >=
    majorityDate(dateOfBirth, policy.majorityAge)
  );
}

export function initialHandover(): Handover {
  return { state: "not_eligible", guardianAccess: "full", consent: [] };
}

type HandoverEvent =
  | { type: "tick"; dateOfBirth: string; now: Date }
  | { type: "claim"; now: Date; keepGuardian: "read_only" | "none" }
  | { type: "decline"; now: Date };

export function transitionHandover(
  current: Handover,
  event: HandoverEvent,
  policy: HandoverPolicy = DEFAULT_HANDOVER_POLICY,
  notifiedAt?: Date,
): Handover {
  const record = (
    state: HandoverState,
    guardianAccess: GuardianAccess,
    actor: ConsentRecord["actor"],
    grantedBy: ConsentRecord["grantedBy"],
  ): Handover => ({
    state,
    guardianAccess,
    consent: [
      ...current.consent,
      {
        at: event.now.toISOString(),
        actor,
        grantedBy,
        guardianAccess,
        event: state,
      },
    ],
  });

  switch (current.state) {
    case "not_eligible":
      if (
        event.type === "tick" &&
        hasReachedMajority(event.dateOfBirth, event.now, policy)
      )
        // Guardian control ends at majority; read-only support remains
        // until the dependant decides, so support is not cut off abruptly.
        return record("notified", "read_only", "system", "guardian");
      return current;
    case "notified":
      if (event.type === "claim")
        return record("claimed", event.keepGuardian, "dependant", "dependant");
      if (event.type === "decline")
        return record("declined", "none", "dependant", "dependant");
      if (
        event.type === "tick" &&
        notifiedAt &&
        event.now.getTime() - notifiedAt.getTime() >=
          policy.claimWindowDays * 86_400_000
      )
        return record("timed_out", "none", "system", "dependant");
      return current;
    default:
      return current;
  }
}
