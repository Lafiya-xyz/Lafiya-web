# Include consent records in the authenticated patient data export

## Category

Good First

## Summary

Extend the existing profile export to include the patient’s consent history and document the export schema addition.

## Current Behavior

`exportMyProfileData` in `app/(auth)/profile/actions.ts` returns only the `profiles` row with `schemaVersion: 1`. `consent_logs` is a separate user-owned table and is not included.

## Problem

A patient requesting their data receives an incomplete representation of the records Lafiya holds about their consent.

## Why This Matters

Complete export improves user trust, support workflows, and data-subject access handling.

## Proposed Scope

Read the authenticated user’s consent rows using the normal client, add a backward-compatible `consentLogs` field, increment the documented export schema version, and update the download route and schema documentation.

## Acceptance Criteria

- [ ] Export contains all and only the caller’s consent rows.
- [ ] Export schema version and documentation describe the new field.
- [ ] Empty consent history is represented consistently.
- [ ] Existing profile export consumers remain understandable or receive a documented version change.
- [ ] Tests cover authenticated access and data isolation.

## Technical Considerations

Use RLS-backed reads from `consent_logs`; do not use the admin client. Preserve ISO timestamps and avoid including internal auth data.

## Testing Requirements

Test export shape, policy-version/timestamp preservation, and denial of unauthenticated or cross-user access.

## Cross-Repository Impact

None identified.

## Out of Scope

Exporting raw profile secrets, auth credentials, or on-chain private material.

## Complexity

Good First — one existing action, route, type, and focused test set.

## Impact

Medium — closes a concrete completeness gap in a user-facing privacy workflow.

## Suggested Labels

`good-first-issue`, `privacy`, `data-export`
