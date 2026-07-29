## Title
Replace the low-entropy, unsalted record hash with a privacy-preserving commitment scheme that resists preimage/correlation attacks, survives legitimate profile edits, and is compatible with NDPA erasure obligations

## Difficulty
10/10 — Expert. Estimated effort: 5–7 days for a senior engineer.

## Context
`lib/attestation/recordHash.ts` computes the value that gets attested on-chain (the `record_hash` in the Soroban `Attestation` struct, per the README's Shared Contracts section) as a plain SHA-256 over a JSON-serialized object built directly from the patient's emergency fields: `name`, `age`, `bloodGroup`, `genotype`, sorted `allergies`/`medications`/`chronicConditions`, sorted `emergencyContacts`, and `language`. This hash is:
- Looked up via a **fully public, unauthenticated** endpoint (`app/api/attestation/[recordHash]/route.ts`), with no rate limiting anywhere in the request path (`proxy.ts` only gates `/profile` and auth-only pages; the attestation route is untouched).
- Also directly queryable on-chain by anyone via the Soroban contract's `get_attestation(record_hash)`, per the README's contract interface — the hash is designed to be a public, permanent lookup key by construction.

Several of the fields feeding the hash have very low real-world entropy: `bloodGroup` has 9 possible values, `genotype` has 6, and a large fraction of real users will have empty `allergies`/`medications`/`chronicConditions` arrays and no `language` set. Combined with a `name` that is frequently *not* secret (an attacker targeting a specific, identifiable person — the exact threat this product is built around, e.g., a specific patient at a specific facility — often already knows or can obtain that person's full name and rough age), this hash is a low-entropy, unsalted commitment. This is the opposite of a cryptographic hiding commitment: anyone who can guess or narrow down the underlying fields for a specific named individual can compute candidate `record_hash` values offline and test them against the public lookup endpoint or the public contract call to learn whether that person has a Lafiya card and whether it is verified — without ever knowing the person's `card_public_id`, and without the "no personal health data ever touches the blockchain" privacy guarantee actually holding up against a targeted adversary who is willing to compute a modest number of candidate hashes.

Separately, `computeRecordHash` recomputes the hash fresh from whatever the *current* profile row contains, every time it's called (`app/(public)/card/[id]/page.tsx:62`, `app/(auth)/profile/profile-form.tsx:26-36`). There is no stored "hash as of last attestation" anywhere in the schema (`lib/supabase/types.ts`'s `ProfileRow` has no such column). This means any edit to a patient's profile — even fixing a typo in an allergy — silently changes the hash the card computes, so the on-chain attestation for the *old* hash no longer matches, and the card silently reverts to "not verified" with no record of what the last-attested state was, no diff, and no re-attestation request workflow anywhere in the codebase. The intent to solve this is visible (the broken, duplicated attempt in `app/(auth)/profile/profile-form.tsx` computes a hash client-side and calls `validateAttestation` to show a "no longer valid... please request a new verification" banner) but there is no actual re-attestation request flow to link to, and the computation happens client-side against a function that pulls in server-only Stellar SDK code (a distinct, cross-cutting concern this issue's design must not ignore, since fixing the hash scheme is the right place to also fix where it's computed).

Finally, patient deletion (`deleteAccount` in `app/(auth)/profile/actions.ts`) removes the Supabase row and storage objects, but the record hash that was once attested may remain permanently resolvable on the immutable Stellar ledger. Given the low-entropy preimage weakness above, "deleting your data" does not actually make the commitment to your prior data unrecoverable if an adversary can still guess/reconstruct the preimage after the fact — a real tension with NDPA's data-subject rights that the current design has not addressed at all.

## Problem statement
Design and implement a record-commitment scheme for the emergency-card data that:
1. Is not practically invertible by an adversary who knows or can narrow down a specific patient's likely field values (i.e., resists the low-entropy dictionary/correlation attack described above), while remaining a fixed-size, deterministic value a Soroban contract can store and compare (`BytesN<32>`, per the existing on-chain struct — you may not require a different on-chain type without justifying why the change is necessary and minimal).
2. Provides a coherent story for what happens when a patient edits their profile after being attested — either a stable identifier that survives non-material edits, or an explicit, testable "attestation is now stale" detection and re-attestation request mechanism (you decide, and justify the tradeoff between hash stability and the contract's "hash = data" invariant).
3. Provides a coherent, documented story for account deletion given that a commitment may already be permanently on-chain — you must explicitly address what "the patient deleted their account" means for previously-attested on-chain hashes, and design the off-chain system so it does not make the erasure problem worse than it has to be (e.g., a per-patient secret that, once discarded, makes any future preimage search for their *specific* record computationally infeasible even if some fields are guessable).

## Current behavior
- `lib/attestation/recordHash.ts` — `computeRecordHash` (or whatever the fixed version of this currently-syntax-broken function is called — see the unrelated build-breakage note) canonicalizes fields directly into `JSON.stringify` and SHA-256s the result with no salt, pepper, or per-user secret.
- `app/api/attestation/[recordHash]/route.ts` — accepts any 64-hex-char string and performs a live lookup, unauthenticated, unrate-limited.
- `lib/supabase/types.ts`'s `ProfileRow` — no column tracks the hash (or a commitment to it) as of the last successful attestation.
- `app/(auth)/profile/profile-form.tsx` — contains an unfinished, broken attempt at client-side "is my attestation still valid" detection with no corresponding request-new-verification flow anywhere in the app.

## Required behavior
- A documented, justified commitment scheme (e.g., an HMAC with a per-patient server-held secret pepper stored alongside the profile, or a salted hash with the salt tracked separately from the public-facing hash) such that an adversary with the public `record_hash` lookup endpoint and/or on-chain read access, but without the per-patient secret, cannot feasibly enumerate candidate patients even with full knowledge of a target's name/age/blood group and a reasonable guess at other fields.
- A concrete answer, backed by a new column/migration if needed, to "does editing allergies from `[]` to `['Penicillin']` invalidate the existing attestation, and how does the UI surface that to the patient and to a CHW who needs to re-attest?" — implemented, not just described.
- A concrete, implemented answer to "what happens to the per-patient secret/pepper on account deletion?" that measurably improves the erasure story (e.g., proves that deleting the secret makes future preimage search infeasible for that patient specifically, even though the on-chain hash itself cannot be deleted).
- The public attestation lookup route must not become a practical oracle for enumerating valid record hashes faster than the entropy budget you've designed for allows — add whatever rate limiting or scheme property makes this true, and demonstrate it with a test that simulates a brute-force attempt against your scheme's assumptions.

## Constraints
- The on-chain contract interface changes only if unavoidable, and any such change must be called out explicitly as a cross-repo, breaking change to `lafiya-contracts`'s `Attestation` struct — prefer a solution that keeps `record_hash: BytesN<32>` and the existing `attest`/`get_attestation` signatures untouched if at all possible.
- Must not require re-attesting every existing patient record as a precondition of shipping (consider a migration/versioning strategy if the scheme change affects already-attested hashes).
- Must not break `tests/integration/emergency-card-rpc.test.ts` or `tests/integration/profiles-column-contract.test.ts`'s column-classification contract without updating them deliberately and explaining why in the PR.
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] A written threat model (in the PR) quantifying the entropy/search-space an adversary faces under the old scheme vs. the new one, for a realistic "attacker knows name + age, guesses everything else" scenario.
- [ ] A test that simulates the brute-force/correlation attack against the old scheme (proving it works, as a regression guard framed as "this must NOT work post-fix") and against the new scheme (proving it does not, within a defined, documented computational budget).
- [ ] A working, tested "profile edited since last attestation" detection surfaced in the profile UI, wired to a real (even if minimal) re-verification request path — not a dangling banner with no destination.
- [ ] A working, tested account-deletion path that discards whatever per-patient secret the scheme relies on, with a test proving that post-deletion, the previously-computed public hash can no longer be correlated back to new guesses about that patient via the app's own commitment function.
- [ ] `npm run typecheck`, `npm run lint`, and `npm run build` pass; `npm run test:integration` passes against a local Supabase instance.

## Out of scope
- The Soroban attestation resilience/decoding layer (separate issue in this batch) — assume `getAttestation`/`decodeAttestation` work correctly against whatever hash you pass them.
- The `lafiya-contracts` Rust implementation itself, beyond documenting any required interface change.
- Building the actual CHW re-attestation UI/tool (`lafiya-verifier`) — you only need to wire the patient-facing "request re-verification" trigger to *something* real and testable (e.g., a queued request record), not a full CHW-side experience.

## Hints and references
- HMAC-based commitment schemes and "salted hash with a per-subject pepper" patterns for pseudonymization under GDPR/NDPA-style regimes (see NIST SP 800-63B's guidance on salted/peppered credential storage for the general pattern, adapted here to a data-commitment rather than a password context).
- W3C Verifiable Credentials' selective-disclosure and hashing approaches (README already cites this as a design influence) — in particular, how VC schemes handle "prove commitment to data without revealing it" versus this project's current "hash raw data directly" approach.
- Nigeria Data Protection Act 2023's data-subject erasure provisions, for scoping what "reasonably discharges the erasure obligation" means when a permanent on-chain commitment cannot itself be deleted.
