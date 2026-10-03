# CHW Protocol Code Map

This document maps the CHW verification protocol implementation and documents the
invariants enforced by the model-based property tests in
`lib/chw-protocol/__tests__/intent.model.test.ts`.

## Modules

- `lib/chw-protocol/intent.ts` — the verification intent state machine: states,
  commands, and the pure transition function.
- `lib/chw-protocol/workflow.ts` — orchestration around intents (create, attest,
  finalize, invalidate, quarantine, release, settle).

## States

| State        | Terminal | Description                                                        |
| ------------ | -------- | ------------------------------------------------------------------ |
| `created`    | no       | Intent created, awaiting an observed attestation.                  |
| `observed`   | no       | An attestation has been observed for the intent.                   |
| `finalized`  | no       | The intent has been finalized and is eligible for settlement.      |
| `quarantined`| no       | The intent is held pending review; it can be released or invalidated. |
| `settled`    | yes      | The intent has been settled exactly once.                          |
| `invalidated`| yes      | The intent was invalidated (e.g. by a reorg).                      |

## Commands

| Command            | Allowed from                          | Result                          |
| ------------------ | ------------------------------------- | ------------------------------- |
| `create`           | (initial)                             | `created`                       |
| `attestObserved`   | `created`                             | `observed`                      |
| `finalize`         | `observed`                            | `finalized`                     |
| `invalidate`       | `created`, `observed`, `finalized`, `quarantined` | `invalidated`        |
| `quarantine`       | `observed`, `finalized`               | `quarantined`                   |
| `release`          | `quarantined`                         | `finalized`                     |
| `settle`           | `finalized`                           | `settled`                       |

## Invariants

These invariants are checked after every generated command by the model-based
property tests (`fast-check` `fc.commands`):

1. **No double settlement.** An intent settles at most once. Once `settled`, no
   further `settle` command is accepted and the settlement count stays at `1`.
2. **Terminal states are absorbing.** `settled` and `invalidated` accept no
   further commands; the state never changes after entering a terminal state.
3. **Every transition is valid.** Each accepted command moves the intent along
   an edge listed in the command table above; any command not allowed from the
   current state is rejected without mutating the intent.

## Testing

- Model-based property tests live alongside the protocol modules and run in CI.
- PRs run a lower `numRuns`; the nightly job runs a higher `numRuns`.
- Shrunk counterexamples are kept as regression tests.

## Out of Scope

The database-level state machine is documented and tested separately.
