import { describe, expect, it } from "vitest";

import { findAccountDeletionPolicyProblems } from "./check-account-deletion-policy.mjs";

describe("findAccountDeletionPolicyProblems", () => {
  it("requires a declared policy for direct user references and non-cascading descendants", () => {
    const problems = findAccountDeletionPolicyProblems(
      [
        {
          table: "public.profiles",
          columns: ["user_id"],
          directReference: true,
          nonCascadingReference: false,
        },
        {
          table: "public.profile_notes",
          columns: ["profile_id"],
          directReference: false,
          nonCascadingReference: true,
        },
        {
          table: "public.cascade_children",
          columns: ["profile_id"],
          directReference: false,
          nonCascadingReference: false,
        },
      ],
      { "public.profiles": { action: "delete" } },
    );

    expect(problems).toEqual(["public.profile_notes: missing deletion policy"]);
  });

  it("requires legal basis and minimization for retained data", () => {
    expect(
      findAccountDeletionPolicyProblems(
        [
          {
            table: "public.audit_events",
            columns: ["user_id"],
            directReference: true,
            nonCascadingReference: false,
          },
        ],
        { "public.audit_events": { action: "retain" } },
      ),
    ).toEqual([
      "public.audit_events: retained data needs a legalBasis",
      "public.audit_events: retained data needs a minimization note",
    ]);
  });

  it("rejects stale policy entries and invalid actions", () => {
    expect(
      findAccountDeletionPolicyProblems(
        [
          {
            table: "public.profiles",
            columns: ["user_id"],
            directReference: true,
            nonCascadingReference: false,
          },
        ],
        {
          "public.profiles": { action: "ignore" },
          "public.removed_table": { action: "delete" },
        },
      ),
    ).toEqual([
      'public.profiles: invalid action "ignore"',
      "public.removed_table: policy has no matching catalog table",
    ]);
  });
});
