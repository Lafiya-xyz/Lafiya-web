# ADR 004: Delegated caregiver model (guardianship)

Status: accepted for issue #531.

## Context

Children, elderly patients, and people with disabilities often cannot manage their own Lafiya card. A guardian (parent, carer, or trusted adult) needs to create and maintain dependent profiles without those profiles being owned by a separate `auth.users` row — which would require the dependant to have their own email/phone account and session.

The current model is strictly 1 account : 1 profile. Guardianship requires a new authorization dimension that crosses RLS, Server Actions, and the export route.

## Decision

### Data model

Two new tables in `public`:

**`dependants`** — a profile owned by a guardian account rather than a `auth.users` row.

```
id              uuid primary key
guardian_user_id uuid references auth.users(id) on delete cascade
name            text not null
date_of_birth   text
-- other clinical snapshot columns mirroring profiles (nullable)
created_at      timestamptz default now()
updated_at      timestamptz default now()
```

Dependant profiles share the same clinical columns as `profiles` but do not have a corresponding `auth.users` row. They are identified by a UUID, not a `user_id`.

**`guardianships`** — explicit, auditable relationship between an auth user and a profile or dependant.

```
id                    uuid primary key default gen_random_uuid()
guardian_id           uuid references auth.users(id) on delete cascade
dependant_profile_id  uuid references dependants(id) on delete cascade
role                  text not null check (role in ('primary', 'secondary'))
granted_at            timestamptz not null default now()
revoked_at            timestamptz
unique (guardian_id, dependant_profile_id)
```

**`guardian_audit_log`** — append-only record of every guardian action with both actor and subject IDs for the audit trail.

```
id              uuid primary key default gen_random_uuid()
actor_id        uuid references auth.users(id)  -- the guardian performing the action
subject_id      uuid                             -- the dependant profile acted upon
action          text not null                    -- e.g. 'create_dependant', 'update_dependant', 'delete_dependant'
meta            jsonb default '{}'
occurred_at     timestamptz not null default now()
```

### Authorization helper

A security-definer function `can_manage_profile(p_dependant_id uuid)` returns `boolean`. It checks:
1. The caller is the `guardian_id` in an active (non-revoked) row in `guardianships` for the given `p_dependant_id`.

Server Actions use `profile_id` as the subject, never `auth.uid()` alone.

### RLS

`dependants`: owner = guardian_user_id. All operations (select, insert, update, delete) scoped to `auth.uid() = guardian_user_id`.

`guardianships`: guardian can read their own rows; inserts go through a security-definer RPC only.

`guardian_audit_log`: insert only via security-definer RPCs; no direct user reads (audit is privileged).

### Age of majority

When a dependant reaches 18, the guardian relationship should be reviewed. A `date_of_birth` column on `dependants` allows a cron job or the UI to surface this. Automated enforcement (auto-revoking guardianship at 18) is deferred to a future ADR; the current design stores the data needed to implement it.

### Consent basis

Guardians acknowledge consent on behalf of dependants at profile creation. The `guardian_audit_log` records the `grant_consent` action. Dependants who gain their own account can later claim ownership (future ADR).

## Alternatives considered

**Shared auth.users account** — rejected: exposes the guardian's credentials to the dependant and prevents independent revocation.

**Sub-profiles on the existing `profiles` table** — rejected: mixes self-owned and guardian-owned records in one table, complicating RLS and the 1:1 `user_id` assumption that other parts of the codebase rely on.

## Consequences

- A guardian can manage up to 5 dependant profiles (enforced by the `create_dependant` RPC).
- Server Actions that touch dependant data accept `dependantId` and verify access via `can_manage_profile()` before any write.
- The audit log records both `actor_id` (guardian) and `subject_id` (dependant) for every action — the trail distinguishes who acted on whose behalf.
- Transferring guardianship between accounts is out of scope.
- No cross-guardian data leakage: RLS policies use `auth.uid() = guardian_user_id` and the security-definer helper.
