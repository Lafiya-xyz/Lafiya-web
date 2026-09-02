# ADR 001: Governed record revisions, consent, and deletion

Status: accepted for issue #173. Schema contract: `lafiya.record-commitment` v1.

## Decision

`record_revisions` is the immutable source of clinical revision history. `profiles` remains a denormalized current snapshot and carries `current_revision_id` for the expand/migrate compatibility window. `save_record_revision` owns the transaction boundary: it locks the snapshot, compares the expected UUID revision token, inserts one successor, advances the snapshot, and supersedes obsolete verification work. The unique predecessor index and transaction make retries and competing tabs safe. A `40001 / STALE_REVISION` response is the stable conflict contract.

Clinical values use explicit provenance (`absent`, `unknown`, `patient_reported`, `clinician_verified`) in revision metadata. Enum `unknown`, an absent/null value, an empty list (none recorded), and a withheld projection are distinct. The public RPC returns values only through its fixed allowlist plus `disclosure_states`; withheld values are null and must never be rendered as “none”.

Commitments use normalized UTF-8 NFC text, E.164 phone numbers when valid, deterministic list/contact order, JSON schema version 1, and HMAC-SHA256 with the private per-record secret. Date of birth, photo URL, and disclosure preferences are presentation fields and do not alter the commitment. Golden vectors in `contracts/` are the verifier/Soroban handoff.

Consent is append-only and purpose/version-specific. Current consent is the most recent event. Withdrawal does not alter history, but `get_emergency_card` immediately denies public disclosure and the service worker deletes/refuses cached HTML when offline-cache consent is absent. Existing accounts retain only the required account-processing acknowledgement; public disclosure and offline caching remain withheld until the account holder explicitly opts in.

Historical revisions are retained only while the account exists. Auth deletion cascades relational history and secrets; avatar deletion occurs before auth deletion. An immutable Stellar commitment cannot be erased, but contains only a keyed one-way commitment—not health data or an application identifier. Production deletion orchestration must retain no patient identifier in an external job payload.

## Consequences

Revision history is immutable and append-only; there is no in-place edit path. Concurrent tab saves are safe via optimistic locking (`STALE_REVISION`), but clients must handle the conflict response and retry with fresh state. All HMAC commitments depend on the per-record secret: losing the secret makes historical commitments unverifiable, so secret rotation is forward-only and old commitments are archived rather than deleted. Consent is append-only; withdrawal is immediate for disclosure but cannot erase committed Stellar hashes. The compatibility INSERT trigger must be removed once old clients are retired.

## Migration and recovery

The migration is forward-only. It backfills exactly one revision for each existing profile and preserves `last_attested_hash` as the commitment when present. Unattested rows receive an opaque, unverified placeholder until their first governed save. Rehearse with `npx supabase db reset`; query `record_revision_reconciliation` as service role and require `current_matches = 1`. Roll forward by fixing data/function behavior in a later migration; do not drop revisions or restore mutable writes.

The old direct INSERT path is temporarily supported by a trigger for seeds/older clients. It creates one unverified revision. All application edits use the atomic RPC. Remove this compatibility path only after deployed clients no longer insert profiles directly.
