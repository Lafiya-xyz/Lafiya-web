# Patient-Visible Consent History (Closes #146)

## Summary

Adds a patient-visible **consent history** to the authenticated profile so a
patient can see the data-processing consent they have granted, and acknowledge
the current privacy policy when a new version becomes active.

This implements issue #146: *Add patient-visible consent history*.

> **Privacy note:** this surfaces only the consent the patient has *themselves*
> granted. It does **not** expose any other patient's consent. Row-level security
> and app-layer scoping guarantee each patient sees only their own rows.

## What changed

### Single source of truth for the active policy (`lib/consent.ts`)
- Defines `CURRENT_POLICY_VERSION = "ndpa-2023-v1"` and `CURRENT_POLICY_LABEL`.
- Exports `POLICY_ROUTES` (e.g. `/terms`, `/privacy`) so the UI can link to the
  governing documents.
- The signup flow (`app/(auth)/signup/actions.ts`) now imports
  `CURRENT_POLICY_VERSION` from here instead of re-declaring it, removing a
  duplicate constant that could drift.

### Consent data access (`app/(auth)/profile/consent/actions.ts`)
Server actions, scoped to the authenticated user:
- `getConsentHistory()` — reads `consent_logs` rows for the signed-in user only,
  returned as `{ policyVersion, acceptedAt }[]`. Returns `[]` when unauthenticated
  or on error (never another user's data).
- `acknowledgeCurrentPolicy()` — inserts a row for the current policy version.
  Idempotent: a duplicate (unique `(user_id, policy_version)`) is reported as
  `already_acknowledged` rather than an error.

### Database access control (`supabase/migrations/20260820000000_consent_logs_user_insert.sql`)
- Adds the `consent_logs_insert_own` INSERT policy so patients can only insert
  rows for **themselves** (`auth.uid() = user_id`).
- Grants `INSERT` on `consent_logs` to `authenticated` (the SELECT policy
  `consent_logs_select_own` already restricted reads to the owner).

### UI (`app/(auth)/profile/consent-history.tsx`, `acknowledge-consent-button.tsx`)
- `ConsentHistory` (async server component) loads the user's history and renders
  a **Consent history** section on the profile page.
- Shows recorded policy versions and when each was accepted, links to Terms and
  Privacy Policy, and — only when the current version is not yet recorded —
  shows an amber prompt with an **Acknowledge current policy** button.
- `AcknowledgeConsentButton` (client component) calls the server action and shows
  inline success / already-acknowledged / error states.
- Wired into `app/(auth)/profile/page.tsx`.

## Access-control / privacy guarantees
- **App layer:** both actions call `auth.getUser()` and always filter/insert with
  the authenticated `user_id`; no request parameter is trusted for the user id.
- **Database layer:** RLS policies `consent_logs_select_own` and the new
  `consent_logs_insert_own` enforce the same constraint in the database, so even
  direct access cannot read or write another patient's consent.
- Unit tests assert the query is scoped to the authenticated id (`user-a` vs
  `user-b`), that cross-user rows are never returned, and that acknowledgement is
  idempotent.

## Tests
- `app/(auth)/profile/consent/actions.test.ts` (8 tests): history scoping,
  unauthenticated empty results, error safety, acknowledgement insert + unique
  violation idempotency, non-unique error reporting, no-session refusal.
- `app/(auth)/profile/consent-history.test.tsx` (3 tests): renders rows, prompts
  for acknowledgement when missing, empty-state rendering.

All project tests in `app/(auth)/profile` and `app/(auth)/signup` pass; `tsc
--noEmit`, ESLint, and Prettier are clean.

## Migration / deployment
The new migration adds an INSERT policy and grant. Apply via the project's normal
Supabase migration flow. No breaking changes; the UI degrades gracefully (empty
state) if no consent exists yet.

---

Closes #146
