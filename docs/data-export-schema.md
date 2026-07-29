# Patient Data Export Schema

Endpoint: `GET /profile/export` (authenticated patients only)

## Response format (JSON)

\`\`\`json
{
  "exportedAt": "ISO 8601 timestamp",
  "schemaVersion": 1,
  "profile": {
    // full contents of the caller's own public.profiles row
  }
}
\`\`\`

## Access control

- The export is generated via a Supabase server-side client scoped to the
  authenticated session (cookie-based), never the service role key.
- Row Level Security (RLS) on `public.profiles` ensures `select` only ever
  returns rows where `user_id` matches `auth.uid()`.
- No user-supplied ID is accepted anywhere in the export path — the target
  user is always derived from the session.