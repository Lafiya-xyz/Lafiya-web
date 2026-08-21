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
