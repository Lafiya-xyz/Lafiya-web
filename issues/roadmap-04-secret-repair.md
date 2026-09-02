# Add durable detection and repair for profiles missing an attestation secret

## Category

Intermediate

## Summary

Make profile-secret provisioning observable and recoverable when a profile save succeeds but `ensureRecordSecret` fails.

## Current Behavior

`upsertProfile` in `app/(auth)/profile/actions.ts` saves the profile first and treats secret-provisioning failure as non-fatal. The public card then reports verification as unavailable when `getSecretByCardPublicId` cannot find a secret.

## Problem

A transient service-role or database failure can leave a valid patient profile permanently unable to compute its attestation hash, with no repair state or operator visibility.

## Why This Matters

It protects the trust workflow from partial writes and prevents silent loss of a patient’s ability to be re-verified.

## Proposed Scope

Add an idempotent repair path that authenticates the patient, verifies the profile exists, creates the missing secret with the existing admin-only helper, and reports structured success/failure. Add a private health signal or operational log for repeated failures without exposing health data.

## Acceptance Criteria

- [ ] A profile with a missing secret can be repaired without changing an existing secret.
- [ ] Concurrent repair requests remain idempotent.
- [ ] Failure is visible to the patient as an actionable state and to operations as a redacted event.
- [ ] Account deletion still removes the secret through the existing cascade.
- [ ] Integration tests cover missing-secret repair and cross-user denial.

## Technical Considerations

Use `profile_secrets`, `ensureRecordSecret`, `createAdminClient`, and the existing redaction logger. Never return the raw secret or include it in logs.

## Testing Requirements

Test transient failure/retry behavior, existing-secret preservation, concurrent calls, and verification recovery after repair.

## Cross-Repository Impact

None identified; the record-hash contract remains unchanged.

## Out of Scope

Changing the HMAC commitment scheme or re-attesting profiles automatically.

## Complexity

Intermediate — spans server actions, admin-only persistence, UI state, and integration tests.

## Impact

High — prevents a recoverable infrastructure failure from breaking the attestation lifecycle.

## Suggested Labels

`intermediate`, `reliability`, `security`, `attestation`
