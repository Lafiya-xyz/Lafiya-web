# Environment Variables

This is the single authoritative reference for every environment variable consumed by Lafiya. The source of truth is the Zod schemas in [`lib/env.ts`](../lib/env.ts) (client-safe variables) and [`lib/runtime-config.ts`](../lib/runtime-config.ts) (server-only, called via [`lib/env-server.ts`](../lib/env-server.ts)).

Copy `.env.example` to `.env.local` and fill in the values. Variables marked **Required** must be set before the app boots. Variables marked **Optional** are only needed for specific subsystems — you can leave them empty if you are not working on that feature.

---

## Quick local setup

```bash
npx supabase start    # prints ANON_KEY, SERVICE_ROLE_KEY, and API_URL
cp .env.example .env.local
# Fill in the three Supabase values printed above, then:
npm run dev
```

For pure UI work (no Stellar/Soroban, no Sentry, no CHW payout indexer) you only need the three Supabase variables and `LAFIYA_DEPLOYMENT_ENV=development`.

---

## Supabase

These are the core variables. The app cannot boot without them.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Required** | Yes | Base URL of the Supabase project (local or hosted). Used by both the browser client and the server client. | `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Required** | Yes | Public anon JWT for the Supabase JS client. Safe for the browser — Row-Level Security enforces access at the database level. | _(printed by `supabase start`)_ |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | **No — server only** | Service-role JWT that bypasses RLS. Used only in Server Components and Route Handlers for admin operations. Never expose this to the browser. | _(printed by `supabase start`)_ |

---

## Deployment identity

Controls how the runtime validates its own configuration. Required for all environments.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `LAFIYA_DEPLOYMENT_ENV` | **Required** | No | One of `development`, `test`, `ci`, `preview`, `staging`, `pilot`, `production`, `mainnet`. Governs which runtime checks are enforced (e.g. production requires live attestation, Sentry, and a build revision). Defaults to `development` if unset when `NODE_ENV` is not `production`. | `development` |
| `LAFIYA_BUILD_REVISION` | Optional — **Required in production** | No | A commit SHA or other unique build identifier. Required when `LAFIYA_DEPLOYMENT_ENV` is `production` or `mainnet`. | `abc1234` |
| `LAFIYA_SCHEMA_COMPATIBILITY` | Optional — **Required in production** | No | Must match the `CURRENT_SCHEMA_COMPATIBILITY` constant in `lib/runtime-config.ts`. Guards against deploying old app code against a migrated schema. | `20260821170000` |

---

## Stellar / Soroban (M1+ — optional for pure UI work)

Needed for the attestation lookup that powers the "verified" indicator on the public card. Safe to leave empty during local UI development — the app boots in `mock` mode when these are absent.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `STELLAR_NETWORK_PASSPHRASE` | **Required** | No | Stellar network identifier. Must match the network the contracts are deployed on. Never set to the mainnet passphrase outside a `production`/`mainnet` deployment. | `Test SDF Network ; September 2015` |
| `SOROBAN_RPC_URL` | **Required** | No | Soroban RPC endpoint used by `lib/stellar/attestation.ts` to call the attestation registry. In `staging`, `pilot`, `production` and `mainnet` it must be an allowlisted HTTPS host (see [RPC/Horizon URL allowlist](#rpchorizon-url-allowlist)). | `https://soroban-testnet.stellar.org` |
| `ATTESTATION_MODE` | Optional | No | `mock` or `live`. Defaults to `live` if `ATTESTATION_CONTRACT_ID` is set, otherwise `mock`. Production always requires `live`. | `mock` |
| `ATTESTATION_CONTRACT_ID` | Optional — **Required when `ATTESTATION_MODE=live`** | No | Deployed `lafiya-contracts` attestation registry contract ID. Must begin with `C` followed by 55 base-32 characters. Leave empty in mock mode. | _(from `lafiya-contracts` deploy output)_ |
| `ATTESTATION_CACHE_TTL_SECONDS` | Optional | No | How long the server caches attestation responses (1–3600 seconds). Defaults to `120`. | `120` |

### RPC/Horizon URL allowlist

`lib/runtime-config.ts` validates `SOROBAN_RPC_URL` and `STELLAR_HORIZON_URL` at startup. The rules depend on the deployment:

| Deployment | Rules |
|---|---|
| `development`, `test`, `ci`, `preview` | Any `http:` or `https:` URL, including `http://localhost`. Other schemes are rejected (`RPC_URL_UNSUPPORTED_SCHEME`). |
| `staging`, `pilot`, `production`, `mainnet` | `https:` only (`RPC_URL_INSECURE_SCHEME`). No IP literals (`RPC_URL_IP_LITERAL`). No `localhost`, single-label, or private-suffix hosts such as `*.local` and `*.internal` (`RPC_URL_PRIVATE_HOST`). The hostname must exactly match an entry in `rpcHostAllowlist` for that deployment (`RPC_URL_HOST_NOT_ALLOWED`). |

`rpcHostAllowlist` also enforces network consistency: `production` and `mainnet` list only mainnet providers, while `staging` and `pilot` list only testnet providers. The list lives in code, not in an environment variable, on purpose: a compromised or mistyped variable is exactly the threat it defends against. To add a provider, open a reviewed PR that updates the list (and ideally [the provider benchmark](rpc-provider-benchmark.md)).

Before the server accepts traffic, `instrumentation.ts` also resolves each configured host once. In allowlisted deployments, boot fails if any resolved address is loopback, private (RFC 1918), carrier-grade NAT, link-local (including the `169.254.169.254` cloud-metadata address), unique-local IPv6, multicast or reserved (`RPC_URL_RESOLVES_PRIVATE`). Boot also fails if a host does not resolve (`RPC_URL_UNRESOLVABLE`, fail closed).

**Residual risk:** the DNS check runs once, at boot. A host that re-resolves to a private address later (DNS rebinding) is not caught by the app. Egress filtering at the network layer is the control for that, and it is out of scope here.

Error messages name the variable but never echo its value, because a provider URL can embed an API key in its path. `GET /api/internal/readiness` reports only the enforced policy (`allowlist` or `permissive`) and the DNS check outcome (`verified`, `skipped` or `not_run`) under `components.rpcEndpoints`, never the URLs or hosts.

---

## CHW protocol (M1+ — optional for pure UI work)

Controls the CHW verification payment protocol. Required together in `production`/`mainnet` deployments; leave empty for local development.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `CHW_PROTOCOL_EPOCH_ID` | Optional — **Required in production** | No | An opaque string identifying the current CHW protocol epoch. Guards against cross-epoch intent replay. | `epoch-2026-q3` |
| `CHW_PROTOCOL_INTENT_SIGNING_KEY` | Optional — **Required in production** | **No — secret** | Server-side signing key for CHW protocol intents. Treat as a secret. Required with `CHW_PROTOCOL_EPOCH_ID`. | _(generate with `openssl rand -hex 32`)_ |

---

## CHW payout indexer (M2+ — optional subsystem)

All-or-nothing group: set `PAYOUT_INDEXER_ENABLED=true` only when every variable in this group is configured. A partially configured group fails at startup rather than silently disabling settlement tracking.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `PAYOUT_INDEXER_ENABLED` | Optional | No | Set to `true` to enable the CHW payout indexer. Defaults to `false`. Do not enable without all variables below. | `false` |
| `STELLAR_HORIZON_URL` | Conditional | No | Horizon REST endpoint used to fetch USDC payment operations. Required when `PAYOUT_INDEXER_ENABLED=true`. Subject to the same [allowlist](#rpchorizon-url-allowlist) as `SOROBAN_RPC_URL`. | `https://horizon-testnet.stellar.org` |
| `STELLAR_USDC_ISSUER` | Conditional | No | Stellar account address (G…) of the accepted USDC issuer. Must be a valid Stellar public key. | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` _(testnet)_ |
| `STELLAR_USDC_ASSET_CODE` | Conditional | No | Asset code of the accepted stablecoin. Must be `USDC`. | `USDC` |
| `CHW_INCENTIVE_POOL_ADDRESS` | Conditional | No | Stellar account address (G…) whose outgoing USDC payments are indexed as CHW payouts. | _(your pool account address)_ |
| `PAYOUT_INDEXER_START_LEDGER` | Conditional | No | Ledger sequence number from which to begin indexing. Used only before durable cursors are established. | `12345678` |
| `PAYOUT_INDEXER_START_PAYMENT_CURSOR` | Conditional | No | Horizon paging cursor for the first payment to index. Used only before durable cursors are established. | `123456789012345678` |
| `PAYOUT_INDEXER_CRON_SECRET` | Conditional | **No — secret** | Bearer token for the authenticated `POST /api/internal/payout-indexer` endpoint. Minimum 32 characters. | _(generate with `openssl rand -hex 32`)_ |
| `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS` | Optional during rotation | **No — secret** | Previous bearer token accepted alongside the current token during a rotation. If set, it must be at least 32 characters. | _(old token during rotation)_ |

---

## Client IP resolution / rate-limit garbage collection (optional)

See `lib/rate-limit.ts` (`getClientIp`) and
`supabase/migrations/20260929210000_rate_and_frequency_limits_gc.sql`.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `TRUSTED_PROXY_HOPS` | Optional | No | How many reverse-proxy hops between the real client and this process are trusted to have appended (not replaced) an X-Forwarded-For entry. Only the entry this many positions in from the right is trusted. Defaults to `1`. | `1` |
| `CLIENT_IP_HEADER` | Optional | No | Platform-injected header that is authoritative for the client IP when present (set/overwritten by the platform itself, so it cannot carry a client-supplied value). Defaults to Vercel's `x-vercel-forwarded-for`; override for other platforms, e.g. `cf-connecting-ip` on Cloudflare. | `x-vercel-forwarded-for` |
| `PURGE_LIMITS_CRON_SECRET` | Optional | **No — secret** | Bearer token for the authenticated `POST /api/internal/purge-expired-limits` fallback endpoint, used only where the Postgres `pg_cron` extension is unavailable (e.g. most local/CI Supabase instances). A deployment whose Postgres has `pg_cron` schedules the purge automatically and never needs this. Minimum 32 characters if set. | _(generate with `openssl rand -hex 32`)_ |

---

## Observability / Sentry (optional — required in production)

Opt-in outside production. The `SENTRY_ENABLED` flag and DSN values must be consistent: enabling Sentry without a DSN, or setting a DSN without enabling Sentry, both fail at startup.

| Variable | Required | Exposed to browser | Purpose | Example / placeholder |
|---|---|---|---|---|
| `SENTRY_ENABLED` | Optional — **Required `true` in production** | No | Set to `true` to enable Sentry error tracking. Defaults to `false`. | `false` |
| `NEXT_PUBLIC_SENTRY_DSN` | Conditional | Yes | Public Sentry DSN for client-side error capture. Required (with or instead of `SENTRY_DSN`) when `SENTRY_ENABLED=true`. | `https://abc123@o0.ingest.sentry.io/0` |
| `SENTRY_DSN` | Conditional | No | Server-side Sentry DSN. Required (with or instead of `NEXT_PUBLIC_SENTRY_DSN`) when `SENTRY_ENABLED=true`. | `https://abc123@o0.ingest.sentry.io/0` |

> **Note:** `SENTRY_AUTH_TOKEN` is a build-time-only secret used by the Sentry Next.js plugin to upload source maps. It is not validated by the runtime schema and does not appear in `.env.example`. Set it in your CI/deployment secrets if you want source map uploads.

---

## Apple/Google Wallet passes (optional — not yet functional)

Signing credentials for the "Add to Wallet" emergency-card pass (issue
#538). See [`docs/wallet-passes.md`](./wallet-passes.md) for what each value
is, how to obtain it, and current implementation status. Unlike the groups
above, these are **not** validated by `lib/runtime-config.ts` at process
startup — the feature is fully optional, so an unconfigured deployment must
keep booting. They are instead validated by `lib/wallet-passes/config.ts`
only when `/api/wallet/apple` or `/api/wallet/google` is called, which
returns HTTP 501 if any variable for that platform is missing.

| Variable | Required | Exposed to browser | Purpose |
|---|---|---|---|
| `APPLE_WALLET_SIGNER_CERT_BASE64` | Conditional | **No — secret** | Base64 PEM of the Apple Pass Type ID certificate. |
| `APPLE_WALLET_SIGNER_KEY_BASE64` | Conditional | **No — secret** | Base64 PEM of the matching private key. |
| `APPLE_WALLET_SIGNER_KEY_PASSPHRASE` | Optional | **No — secret** | Passphrase for the private key, if encrypted. |
| `APPLE_WALLET_WWDR_CERT_BASE64` | Conditional | No | Base64 PEM of Apple's WWDR intermediate certificate. |
| `APPLE_WALLET_PASS_TYPE_IDENTIFIER` | Conditional | No | Registered Pass Type ID, e.g. `pass.xyz.lafiya.emergency`. |
| `APPLE_WALLET_TEAM_IDENTIFIER` | Conditional | No | Apple Developer Team ID. |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_JSON` | Conditional | **No — secret** | Full Google Cloud service-account key JSON. |
| `GOOGLE_WALLET_ISSUER_ID` | Conditional | No | Google Wallet issuer account ID. |
| `GOOGLE_WALLET_CLASS_ID` | Conditional | No | ID of the generic pass class created via the Wallet Objects API. |

---

## Minimum `.env.local` for local UI development

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<printed by supabase start>
SUPABASE_SERVICE_ROLE_KEY=<printed by supabase start>
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
LAFIYA_DEPLOYMENT_ENV=development
ATTESTATION_MODE=mock
SENTRY_ENABLED=false
PAYOUT_INDEXER_ENABLED=false
```
