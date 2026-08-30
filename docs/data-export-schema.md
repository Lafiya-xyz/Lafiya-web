# Patient Data Export Schema

Endpoint: `GET /profile/export` (authenticated patients only)

## Response format (JSON)

\`\`\`json
{
"exportedAt": "ISO 8601 timestamp",
"schemaVersion": 2,
"profile": {},
"recordRevisions": [],
"disclosureSettings": {},
"consentEvents": [],
"verificationRequests": [],
"accessAuditSummaries": [],
"storageObjects": [],
"checksum": { "algorithm": "sha256", "value": "64 lowercase hex characters" }
}
\`\`\`

## `profile` field set

`profile` is populated from an explicit column list on `public.profiles`
(see `exportMyProfileData` in `app/(auth)/profile/actions.ts`), never
`select("*")`. This is deliberate: `profiles` also carries internal,
non-patient-meaningful columns (for example `last_attested_hash`, an
attestation-reconciliation value that the codebase explicitly never exposes
to patients — see the comment on `ProfileRow` in `lib/supabase/types.ts` and
`profiles-column-contract.test.ts`) that must never leak into a patient
export just because they live on the same row.

The exact, exhaustive key set of `profile` is:

- `user_id`
- `card_public_id`
- `name`
- `date_of_birth`
- `photo_url`
- `language`
- `blood_group`
- `genotype`
- `allergies`
- `medications`
- `chronic_conditions`
- `emergency_contacts`
- `last_verified_at`
- `created_at`
- `updated_at`
- `current_revision_id`
- `disclosure_policy`
- `legacy_card_sunset_at`

No other key (in particular, no secret material from
`lib/attestation/recordSecret.ts`'s `profile_secrets` table, which is never
queried by the export path, and no `last_attested_hash`) may ever appear
under `profile`. A regression test locks this key set down — see
`app/(auth)/profile/export/route.test.ts`.

## Access control

- The export is generated via a Supabase server-side client scoped to the
  authenticated session (cookie-based), never the service role key.
- Row Level Security (RLS) on `public.profiles` ensures `select` only ever
  returns rows where `user_id` matches `auth.uid()`.
- No user-supplied ID is accepted anywhere in the export path — the target
  user is always derived from the session.
- Every relational query uses the caller's session and RLS. Storage metadata
  is limited to the caller's `avatars/{user_id}` folder; object bytes and
  signed URLs are not exported.
- The checksum covers the canonical key-sorted JSON payload other than
  `exportedAt` and `checksum`, so repeated exports of unchanged data match.
