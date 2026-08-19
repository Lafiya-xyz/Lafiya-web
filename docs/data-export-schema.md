# Patient Data Export Schema

Endpoint: `GET /profile/export` (authenticated patients only)

## Response format (JSON)

\`\`\`json
{
  "exportedAt": "ISO 8601 timestamp",
  "schemaVersion": 2,
  "profile": {
    // full contents of the caller's own public.profiles row
  },
  "consentLogs": [
    {
      "id": "consent record UUID",
      "user_id": "authenticated patient UUID",
      "policy_version": "accepted privacy-policy version",
      "accepted_at": "ISO 8601 timestamp"
    }
  ]
}
\`\`\`

`consentLogs` is always an array ordered by `accepted_at` ascending. Patients
without consent history receive an empty array. Version 2 is backward-compatible
at the field level: it preserves `exportedAt` and `profile` and adds
`consentLogs`. The download response also exposes version `2` in the
`X-Lafiya-Export-Schema-Version` header.

## Access control

- The export is generated via a Supabase server-side client scoped to the
  authenticated session (cookie-based), never the service role key.
- Row Level Security (RLS) on `public.profiles` and `public.consent_logs`
  ensures `select` only ever returns rows where `user_id` matches `auth.uid()`.
- No user-supplied ID is accepted anywhere in the export path — the target
  user is always derived from the session.
