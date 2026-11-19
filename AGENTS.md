<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Contributor Guide

This file is the entry point for contributors and coding agents. Read it before making changes. It links to the architecture decision records (ADRs) and per-area rules that govern the codebase.

## Before you write code

1. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root). This Next.js version has breaking changes — APIs, conventions and file structure may differ from your training data. Heed deprecation notices.
2. Read the ADRs in `docs/adr/` that touch the area you are changing.
3. Comment a short design note on the issue before opening a PR (see [Design notes](#design-notes)).
4. Changes touching PHI, capabilities, attestation or payouts need a reviewer from the matching area (see [Review rules](#review-rules)).

## Architecture Decision Records

ADRs live in `docs/adr/` and are numbered sequentially. Each ADR records context, the options considered, the decision, and the consequences. Add a new ADR (do not rewrite history) when you change a decision; supersede the old one by reference.

| ADR | Title | Area |
| --- | --- | --- |
| `docs/adr/0001-durable-execution.md` | Durable execution for long-running workflows | Workflows, jobs, outbox |
| `docs/adr/0002-domain-event-catalog.md` | Domain event catalog published as AsyncAPI | Outbox, webhooks, docs |
| `docs/adr/0003-phi-module-boundary.md` | PHI isolation behind `lib/phi/` | PHI, records, exports |

## Design notes

Before implementing, comment a short design note on the issue covering:

- **Problem** — what is broken or missing today, in one or two sentences.
- **Approach** — the shape of the change and the modules it touches.
- **Alternatives** — what you considered and why you rejected it.
- **Risks** — PHI, capabilities, attestation, payouts, migrations, rollout.
- **Test plan** — how the acceptance criteria will be verified, including failure/restart cases.

Keep it short. The design note is a checkpoint for reviewers, not a specification; the ADR carries the durable record of the decision.

## Review rules

Changes are routed to area reviewers based on what they touch:

| Area | Trigger | Required reviewer |
| --- | --- | --- |
| PHI | Any change under `lib/phi/`, or any change to a PHI projection's shape | PHI reviewer |
| Capabilities | Changes to capability grants, checks or tokens | Capabilities reviewer |
| Attestation | Changes to attestation issuance, verification or storage | Attestation reviewer |
| Payouts | Changes to payout calculation, scheduling or disbursement | Payouts reviewer |
| Workflows | Changes to workflow definitions, activities or compensation | Workflows reviewer |

If a change spans multiple areas, request a reviewer for each. When in doubt, request the stricter review.

## Durable execution (ADR-0001)

Long-running, multi-step processes (verification visit lifecycle, payouts, merges) run on the durable workflow engine chosen in `docs/adr/0001-durable-execution.md`. Do not implement multi-step processes as ad hoc state columns plus cron jobs plus outbox events; model them as a workflow.

### Where workflow code lives

- `lib/chw-protocol/workflow.ts` — the verification visit lifecycle workflow definition.
- `lib/jobs/` — scheduled/triggered entry points that start or signal workflows.
- `lib/outbox/` — events emitted by workflows and consumed by other systems.

### Idempotent activities

Every activity must be safe to run more than once. The engine guarantees at-least-once execution of activities across retries and restarts.

- Pass an idempotency key derived from the workflow id and step name to every side-effecting call (payments, notifications, attestation writes).
- Make writes upserts keyed on the idempotency key, or check-then-write inside a transaction with a unique constraint as the backstop.
- Never rely on in-memory state to deduplicate; the process may restart between attempts.
- Activities must not read wall-clock time or randomness directly — take them as inputs so replays are deterministic.

### Compensation

When a later step fails permanently, earlier steps must be undone by explicit compensation activities, run in reverse order.

- Register a compensation for every activity with an external side effect.
- Compensation activities are themselves idempotent and must tolerate the original step never having completed.
- Record compensation outcomes as events in the outbox so failures are visible.

### Restart survival

Workflows must survive a function restart mid-flight. The acceptance test for ADR-0001 kills the process between two steps and asserts the workflow resumes from the last completed step without duplicating side effects. Add a restart test for any new workflow.

## Domain event catalog (ADR-0002)

Every domain event emitted through the outbox or a partner webhook must be documented in the AsyncAPI catalog generated from the event schema registry.

### Adding an event

1. Define the event type and payload schema in `lib/outbox/types.ts` (and `lib/notifications/events.ts` for notification events).
2. Add the channel, payload schema, producer, consumers and per-field data classification to the registry.
3. Regenerate the AsyncAPI document (`docs/api/`) and commit it alongside the code.
4. CI validates the document and fails if any emitted event type is undocumented.

### Data classification

Annotate every payload field with its data classification (e.g. `public`, `internal`, `phi`). PHI fields must be flagged so consumers and reviewers can see what crosses the boundary. Do not add a PHI field to an event payload without a PHI reviewer.

## PHI module boundary (ADR-0003)

`lib/phi/` is the only module allowed to read PHI columns. Everything else consumes purpose-specific projections.

### Rules

- Only `lib/phi/` may query PHI tables. This is enforced by an import-boundary lint rule; do not disable it.
- Other modules import projections from `lib/phi/` — never raw PHI rows.
- Projections are purpose-specific: emergency envelope, export bundle, PDF data, pass content, CHW verification view. Add a new projection rather than widening an existing one.
- Do not log, serialize or return raw PHI outside a projection.

### Ownership and review

- `lib/phi/` is owned by the PHI reviewer. Any change under `lib/phi/`, or any change to a projection's shape, requires a PHI reviewer.
- New projections require a design note describing the purpose, the fields exposed and the consumers.
- Projection changes need tests covering the mapping, including fields that must be omitted.

### Where PHI currently leaks

`app/(auth)/profile/*`, `lib/records`, `lib/pdf` and export routes previously read PHI directly. Move queries and mapping into `lib/phi/` and have these modules consume projections only.