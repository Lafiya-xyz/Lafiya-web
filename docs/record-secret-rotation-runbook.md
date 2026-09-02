# Record secret compromise/rotation runbook

Covers `lib/attestation/recordSecret.ts` and the `public.profile_secrets`
table it's the sole gateway to (migration
`20260729120000_profile_secrets.sql` — zero RLS policies for any role;
service-role only, by design).

## What this secret actually is — read this before doing anything

There is **no single shared secret**. `profile_secrets` holds one
independent, randomly generated 256-bit secret **per patient**
(`profile_secrets.secret`, keyed by `user_id`). It's the HMAC key in
`computeRecordHash` (`lib/attestation/recordHash.ts`):

```
record_hash = HMAC-SHA256(emergency-relevant card fields, patient's secret)
```

`record_hash` is what gets attested **immutably on Stellar** (see
`docs/adr-002-chw-verification-protocol.md` / README's Attestation & Trust
Layer section). This has one consequence that shapes everything below:

> **Changing a patient's secret makes every existing on-chain attestation
> for that patient permanently unverifiable.** There is no way to
> recompute a matching `record_hash` for old card data with a new secret,
> and Stellar attestations can't be edited or deleted. `ensureRecordSecret`
> already refuses to regenerate an existing secret for exactly this
> reason — ordinary "my data changed" re-attestation is handled by
> `save_record_revision` instead, which reuses the same secret and issues
> a fresh commitment for the new data.

So "rotate the secret" is not a routine maintenance operation here — it's
something you do only in response to a suspected compromise, and it has a
real, permanent cost to the affected patient(s): their attestation
history up to that point stops verifying. This runbook exists to make
sure that's a deliberate, understood tradeoff when it happens, not a
surprise discovered afterward.

## Who's authorized

`profile_secrets` has no RLS policies at all — the only way to read or
write it is `createAdminClient()` (`lib/supabase/admin.ts`), which uses
`SUPABASE_SERVICE_ROLE_KEY`. Practically, that means:

- **Rotating a secret** (an ad-hoc DB write — there is no
  `rotateRecordSecret` function in the codebase; see "How to actually
  rotate one" below) requires direct Supabase project database access:
  whoever holds `SUPABASE_SERVICE_ROLE_KEY` or has the Supabase dashboard
  SQL editor for this project.
- Treat this the same as any other production database write with no
  application-layer audit trail of its own — coordinate it the same way
  you would a manual `UPDATE` on any other sensitive table, and log what
  you did and why outside the database (e.g. in the incident ticket).
- Report a suspected compromise the same way as any other vulnerability —
  see `SECURITY.md` (`security@lafiya-xyz.org` or a private GitHub
  security advisory).

## Two different incident shapes

### 1. A single patient's secret is suspected compromised

(E.g. it leaked via a logging bug, a debugging session, or similar —
scoped to one `user_id`.)

1. Confirm the scope is really limited to one patient — check whatever
   leaked it for evidence of broader exposure before assuming it's
   isolated.
2. Rotate that one row (see below).
3. The patient's current card page will start showing the existing
   "attestation is stale / doesn't match current data" state on their
   next visit — this is the same UI path already used for ordinary edits
   (`app/(auth)/profile/page.tsx`), so no new UI work is needed. Prompt
   them (support contact, in-app notice, whatever channel is appropriate)
   to re-save their profile, which triggers a fresh attestation under the
   new secret.
4. Nothing else needs re-issuing. Past attestations simply age out of
   relevance the same way an edited-but-not-yet-re-attested profile
   already does today.

### 2. The whole `profile_secrets` table (or the service-role key) is compromised

(E.g. `SUPABASE_SERVICE_ROLE_KEY` leaked, or direct database access was
breached.)

1. If the service-role key itself is the suspected vector: rotate it in
   the Supabase project dashboard first (Settings → API), and redeploy
   with the new value in every environment that has it configured. This
   is a standard Supabase key rotation, not specific to this table.
2. Decide whether to rotate every patient's secret, or only patients with
   an active/relied-upon card in circulation. Rotating all of them is
   safer but invalidates every attestation in the system at once —
   weigh that against the actual likelihood the exposure was read (not
   just accessed) before doing a full rotation.
3. If proceeding with a bulk rotation, script it as a single transaction
   over `profile_secrets` (see below) rather than rotating rows
   one-by-one over time, so there isn't a long window where some
   patients are on old secrets and some on new ones with no way to tell
   which from the application layer.
4. Notify all affected patients that they'll need to re-save their
   profile to restore a verifiable attestation, the same as the
   single-patient case above but at whatever scale applies.
5. File a post-incident note covering how the exposure happened and what
   changed to prevent recurrence — this table having zero RLS policies is
   deliberate defense-in-depth, but it also means there's no
   database-level audit log of who read it; if that's a gap for the
   scale of this incident, note it as a follow-up.

## How to actually rotate one (or many)

There's no application code for this — it's a direct database operation,
by design (same reasoning as `ensureRecordSecret` never doing it
automatically: this must be a deliberate, logged action, not something
reachable from a code path a bug could trigger accidentally).

```sql
-- Single patient:
update public.profile_secrets
set secret = encode(gen_random_bytes(32), 'hex')
where user_id = '<affected-user-id>';

-- All patients (only after the "decide the blast radius" step above):
update public.profile_secrets
set secret = encode(gen_random_bytes(32), 'hex');
```

Run via the Supabase SQL editor or `psql` with the service-role/admin
connection — never expose this as an app-reachable endpoint.
