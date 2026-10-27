# Feature-flag lifecycle

Flags are defined in `lib/flags.ts`. Every key must have an entry in
`FLAG_REGISTRY` with:

| Field       | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `owner`     | Team accountable for the flag and its removal.                                   |
| `kind`      | `kill_switch`, `release` or `experiment`.                                        |
| `expiresAt` | `YYYY-MM-DD`. Required for `release` and `experiment`; `null` for kill switches. |

## Kill switch vs. removable flag

- **Required kill switches** (`kind: 'kill_switch'`) are permanent emergency
  controls and are exempt from expiry. Do not remove them. Current kill
  switches: `attestation_lookup`, `payouts`, `uploads`, `capability_sharing`.
- **Safe-to-remove flags** (`release`, `experiment`) are temporary. Once past
  `expiresAt` the flag should be fully rolled out or rolled back, its code
  paths collapsed, and its registry entry and `feature_flags` row deleted.

## Automation

- `npm run flags:check` (`scripts/check-flags.mjs`) scans `app/`, `lib/`,
  `components/` and `proxy.ts` for `isEnabled('…')` / `getFlagState('…')`.
  References to flags missing from the registry are emitted as CI warnings on
  every pull request (`.github/workflows/flag-lifecycle.yml`).
- The same workflow runs weekly with `--create-issues`: each expired release
  or experiment flag opens a "Remove expired feature flag: <key>" issue
  listing its code references (deduplicated against open issues).
- `GET /api/internal/readiness` reports each flag's `enabled`, `rolloutPct`,
  `kind` and `expired`. Owners and per-user bucketing are never exposed.
