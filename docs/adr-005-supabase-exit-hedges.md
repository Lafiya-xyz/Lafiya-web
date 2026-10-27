# ADR-005: Supabase exit hedges — what to abstract now vs. later

**Date:** 2026-10-22  
**Status:** Accepted  
**Deciders:** Platform lead, Privacy lead, Engineering lead  
**Issue:** [#798 — Supabase exit and portability strategy](https://github.com/org/lafiya-web/issues/798)

---

## Context

Lafiya uses Supabase for authentication (GoTrue), relational storage (Postgres
with RLS), object storage (S3-compatible), and the PostgREST Data API. The
product operates in a regulated health market where data-residency law or vendor
availability changes must be survivable within a defined recovery window.

A full portability inventory is in
[`docs/exit-strategy/supabase-exit-strategy.md`](./exit-strategy/supabase-exit-strategy.md).

The key risk is **time to restore**: if Supabase becomes unavailable or a
data-residency order requires migration, how long would it take to restore full
service on an alternative stack?

---

## Decision

We adopt a **tiered abstraction strategy**: abstract high-value, low-effort
couplings now; defer full stack replacement until it is required.

### Tier 1 — Do now (this sprint)

**`auth.uid()` wrapper function**

Create `app_auth.current_user_id()` in a new `app_auth` schema. All *new* RLS
policies reference this wrapper. A migration that aliases `auth.uid()` to it
allows future retargeting without touching existing policy SQL.

*Rationale:* One-time cost of ~1 hour; saves ~1 week of find-and-replace across
all migrations when exiting. Zero runtime impact.

**`lib/supabase/` boundary**

Enforce that no route, Server Component, or action imports `@supabase/supabase-js`
or `@supabase/ssr` directly — all access must go through `lib/supabase/*.ts`.
This is already true in the codebase; add an ESLint rule to keep it that way.

*Rationale:* Zero runtime cost; isolates the swap surface to four files.

**S3 protocol**

The S3 protocol is already enabled in `supabase/config.toml`. Document the
restore procedure and rehearse it quarterly.

*Rationale:* Storage is the easiest surface to migrate; object data has no
Supabase-specific format.

---

### Tier 2 — Next quarter

**PostgREST audit**

Audit for any remaining direct `.from('table')` calls in client components.
Route all mutations through server actions (already the predominant pattern).

*Rationale:* PostgREST is the hardest dependency to replace. Reducing reliance
now reduces future migration scope without a rip-and-replace today.

**Quarterly restore drill**

Run `scripts/exit-strategy/restore-drill.sh` against a vanilla Postgres instance
on a quarterly schedule. Record results as compliance evidence.

---

### Tier 3 — When triggered

**Full GoTrue → alternative OIDC provider**

Trigger: data-residency order requiring a different host region, or Supabase
service discontinuation.

Recommended path: self-hosted GoTrue (same binary, zero SQL changes) or Clerk
(third-party JWT bridge already present in `config.toml`).

Estimated effort: 3–4 weeks including QA and migration rehearsal.

**PostgREST → explicit API routing**

Trigger: dropping Supabase hosting entirely (e.g., moving to a managed
Postgres + custom API layer).

Estimated effort: 4–6 weeks (all `.from()` calls → explicit server-side queries,
all storage policies → SDK or custom middleware).

---

## Consequences

**Positive:**
- Time to restore a vanilla Postgres + S3 deployment is reduced from "unknown"
  to an estimated 2–3 days for schema + data, 1–2 days for auth provider
  integration, subject to the quarterly drill confirming accuracy.
- The `lib/supabase/` boundary contains the swap surface to four files.
- Storage migration is a same-day operation.

**Negative / accepted risks:**
- We do not abstract PostgREST today. Any remaining direct `.from()` calls in
  client components would require additional work at exit time. The quarterly
  audit tracks this.
- The `auth.uid()` wrapper migration only covers *new* policies. Existing
  policies would require a bulk SQL migration at exit time (~1 week of effort).
  This is accepted as deferred cost.

---

## Alternatives considered

**Full abstraction now (replace all Supabase calls with portable interfaces)**

Rejected. Cost is 6–10 weeks with no user-facing value. The current Supabase
dependency surface is well-documented and the migration path is clear; deferring
until triggered is the appropriate risk posture for an early-stage health product.

**Dual-write to a second Postgres instance continuously**

Rejected. Operational complexity and cost are disproportionate to risk at current
scale. The quarterly restore drill provides sufficient confidence without
continuous dual-write overhead.

**Migrate to self-hosted GoTrue immediately**

Rejected. Self-hosted GoTrue removes the vendor dependency for auth but adds
operational burden (updates, security patches, availability SLA). The risk is
better managed by the Tier 1–2 abstractions + a documented migration path.

---

## Review

This ADR is reviewed every 6 months or when:
- Supabase announces a breaking change or pricing change affecting the project.
- A data-residency inquiry is received.
- The quarterly restore drill identifies a new uncovered coupling.
