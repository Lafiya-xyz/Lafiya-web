# Profile field visibility

Every field on a patient's profile falls into exactly one of three
visibility classes on the public emergency card
(`app/(public)/card/[id]/card-content.tsx`). This table is the single
source of truth tying together what was previously implicit and scattered
across `app/(auth)/profile/privacy-controls.tsx` (the patient-facing
consent/disclosure UI) and `public.get_emergency_card()` (the SQL function
that actually decides what the public card query returns — see
`supabase/migrations/20260821180000_emergency_card_record_updated_at.sql`).

Verified directly against that SQL function's `case when
(p.disclosure_policy#>>'{fields,<field>}')::boolean then ... end` per-field
gating, and against `DEFAULT_DISCLOSURE_POLICY` in
`lib/records/canonicalization.ts` for the default value of each toggle.

## Classification

- **Public-by-default** — included in `disclosure_policy.fields`, defaults
  to `true`, and the patient may uncheck it in Privacy & consent to
  withdraw it from the public card.
- **Private-by-default** — included in `disclosure_policy.fields` but
  defaults to `false`; the patient must actively opt in. (No field
  currently uses this class — see note below.)
- **Always private** — never returned by `get_emergency_card()` at all, or
  forced off regardless of any patient setting. No UI control exists for
  these; they can never appear on the public card.
- **Always public metadata** — not part of the per-field disclosure map at
  all; shown on every active public card as trust/freshness context,
  independent of which content fields the patient chose to share.

| Field | Classification | Default | Notes |
|---|---|---|---|
| `name` | Public-by-default | `true` | Toggle in Privacy & consent |
| `age` (derived from `date_of_birth`) | Public-by-default | `true` | Only the computed age is ever disclosable, never the raw DOB |
| `photo_url` | Public-by-default | `true` | Toggle in Privacy & consent |
| `blood_group` | Public-by-default | `true` | Toggle in Privacy & consent |
| `genotype` | Public-by-default | `true` | Toggle in Privacy & consent |
| `allergies` | Public-by-default | `true` | Toggle in Privacy & consent |
| `medications` | Public-by-default | `true` | Toggle in Privacy & consent |
| `chronic_conditions` | Public-by-default | `true` | Toggle in Privacy & consent |
| `emergency_contacts` | Public-by-default | `true` | Toggle in Privacy & consent |
| `language` | Public-by-default | `true` | Toggle in Privacy & consent |
| `date_of_birth` | Always private | n/a | No checkbox exists; `updateDisclosureChoices` forces `fields.date_of_birth = false` on every save (`app/(auth)/profile/actions.ts`) |
| `user_id` | Always private | n/a | Never selected by `get_emergency_card()` |
| `card_public_id` | Always private | n/a | Never selected by `get_emergency_card()` |
| `current_revision_id` | Always private | n/a | Never selected by `get_emergency_card()` |
| `created_at` | Always private | n/a | Never selected by `get_emergency_card()` |
| `last_attested_hash` | Always private | n/a | Explicitly excluded — see the `ProfileRow` comment in `lib/supabase/types.ts` and `profiles-column-contract.test.ts` |
| raw `disclosure_policy` object | Always private | n/a | Only a derived `disclosed`/`withheld` summary map is returned, never the raw policy JSON |
| `profile_secrets.secret` (HMAC pepper, `lib/attestation/recordSecret.ts`) | Always private | n/a | Lives in a separate table with zero RLS policies; only reachable via the service-role admin client, never joined into the public card query |
| `trust_state` | Always public metadata | n/a | Rendered unconditionally in the "Record trust and freshness" section |
| `trust_updated_at` | Always public metadata | n/a | Rendered unconditionally as "Verification last checked" |
| `record_updated_at` (`profiles.updated_at`) | Always public metadata | n/a | Rendered unconditionally as "Record updated" |
| `authorization_expires_at` (`profiles.legacy_card_sunset_at`) | Always public metadata | n/a | Rendered unconditionally as "Authorization valid until" |
| `offline_cache_allowed` | Always public metadata | n/a | Consumed by the service worker offline envelope, not directly rendered |
| `disclosure_states` (derived map) | Always public metadata | n/a | Lets the offline envelope know what was withheld without a re-fetch |

Note on "private-by-default": as of this writing, every toggleable field in
`disclosure_policy.fields` defaults to `true` (public-by-default,
opt-out) — there is currently no field a patient must actively opt into.
If a private-by-default field is added in the future, add it to this table
under that class rather than lumping it in with "Always private".

See also: [`docs/data-export-schema.md`](./data-export-schema.md) for the
separate (larger) field set available to the patient via their own
authenticated data export, which is not visibility-gated by
`disclosure_policy` at all.
