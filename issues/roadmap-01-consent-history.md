# Add a patient-visible consent history and policy-version acknowledgement

## Category

Good First

## Summary

Add a profile capability that lets a patient view the consent policy versions recorded for their account and acknowledge the currently active policy version when required.

## Current Behavior

Signup validates consent and writes `public.consent_logs` through the service-role client in `app/(auth)/signup/actions.ts`. The profile page does not expose those records, and there is no active-policy version check outside signup.

## Problem

Patients cannot verify what consent they granted, while policy changes have no user-facing acknowledgement path.

## Why This Matters

It improves transparency and supports accountable health-data processing without exposing another patient’s data.

## Proposed Scope

Add a server action and profile section that reads only the authenticated user’s consent rows, displays policy version and timestamp, and records a new acknowledgement idempotently for a configured current policy version. Keep policy content linked to the existing terms/privacy routes.

## Acceptance Criteria

- [ ] Only the signed-in user’s consent rows are returned.
- [ ] Existing consent rows display policy version and acceptance time.
- [ ] Re-acknowledging a version is idempotent.
- [ ] The current policy version is not hard-coded in multiple components.
- [ ] RLS and server-action tests cover cross-user access denial.

## Technical Considerations

Use `consent_logs`, its existing unique `(user_id, policy_version)` constraint, `createClient`, and the hand-authored Supabase types. Do not expose service-role credentials to the client.

## Testing Requirements

Test rendering the user’s history, duplicate acknowledgement, and rejection of another user’s rows.

## Cross-Repository Impact

None identified.

## Out of Scope

Legal policy authoring, consent withdrawal semantics, and changes to the public emergency-card projection.

## Complexity

Good First — localized profile/UI and existing table access patterns.

## Impact

Medium — improves patient control and compliance transparency.

## Suggested Labels

`good-first-issue`, `privacy`, `enhancement`
