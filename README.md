# Lafiya

[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-blue?logo=stellar)](https://stellar.org)
[![Soroban Smart Contracts](https://img.shields.io/badge/Smart%20Contracts-Soroban-purple)](https://soroban.stellar.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Status: Pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#roadmap)

A patient-owned emergency health card on Stellar — the vitals that decide emergency treatment travel with the patient as a scannable QR code, work offline, and can be cryptographically verified by a health worker so a first responder can trust them on the spot.

_Lafiya_ is Hausa for health, safety, and wellbeing.

> **Status:** Pre-alpha · Stellar **testnet** · Live: [lafiya-web.vercel.app](https://lafiya-web.vercel.app) · not yet audited · not a medical device. See [Disclaimer](#disclaimer).

## Overview

Lafiya is a free, patient-owned emergency health card. The handful of facts that change how a patient is treated in an emergency — blood group, genotype, allergies, current medications, chronic conditions — travel with them as a scannable QR code, work offline, and can be cryptographically verified by a health worker.

This repository (`lafiya-web`) contains the patient + responder web app — the Lafiya Card product surface: the public emergency page, the authenticated profile editor, and QR generation. The Soroban attestation contracts, CHW verifier tooling, and project docs live in separate repos — see [Lafiya Organization](#lafiya-organization) below.

### The Problem

In Nigeria, health records are paper, siloed per facility, and effectively lost the moment a patient moves, is referred, or arrives unconscious. In an emergency, the facts that decide treatment are usually unknown to whoever is treating the patient. Wrong assumptions cost lives:

- **Genotype (AS/SS sickle-cell status), blood group, and drug allergies** are rarely known at the point of care
- **Referrals and facility transfers** lose the paper trail entirely
- **Unconscious or non-verbal patients** cannot supply the facts themselves
- **No existing system** lets a first responder trust a record without calling the issuing facility

### What Lafiya Does

- **For the patient / mother** — a free card carried on a phone or printed, that speaks for them when they can't
- **For the responder / clinician** — scan the QR, no login, see only the decision-relevant subset, with a clear "verified" indicator that can be trusted
- **For the community health worker (CHW)** — get paid in USDC on Stellar for each person registered and verified, solving the last-mile distribution problem

## Features

- **Lafiya Card**: a patient-owned profile behind a login; the patient chooses exactly what appears on a minimal, read-only public emergency page reachable by QR
- **Offline-first emergency page**: readable without a login and without a network connection once cached, so a responder can read it in a dead zone — implemented via a service worker (see [Architecture › Offline support](#offline-support))
- **Cryptographic attestation (Soroban)**: a licensed health worker's verification is recorded on-chain as a hash of the record + the attester's identity + a timestamp — never the health data itself
- **CHW incentive rails (USDC on Stellar)**: community health workers are paid a micro-amount per verified registration, with near-zero fees and stablecoin settlement
- **Transparent funding**: grant and donor funds flow on-chain into the CHW incentive pool, so every dollar maps to a countable number of verified cards
- **Privacy by design**: no personal health data ever touches the blockchain; only hashes, attestations, and payments are on-chain

## Architecture

```mermaid
graph TB
    subgraph Card["Lafiya Card (lafiya-web)"]
        PROFILE[Authenticated profile editor]
        PAGE[Public emergency page]
        QR[QR code]
    end

    subgraph DataLayer["Off-chain Data Layer"]
        SUPA[Supabase — encrypted Postgres + Row-Level Security]
    end

    subgraph Proof["Lafiya Proof (lafiya-contracts)"]
        ATTEST[Attestation registry — Soroban]
        ALLOW[Attester allowlist]
        PAY[USDC incentive payouts]
    end

    subgraph Consumers["Who reads / writes it"]
        CHW[Community health worker]
        RESP[Responder / clinician]
        FUNDER[Grant / donor funding pool]
    end

    PROFILE --> SUPA
    SUPA --> PAGE
    PAGE --> QR
    CHW -->|verifies record| ATTEST
    ATTEST --> ALLOW
    ATTEST -->|hash + attester ID + timestamp| SUPA
    RESP -->|scans QR| QR
    QR --> PAGE
    PAGE -.->|checks verified flag| ATTEST
    FUNDER --> PAY
    PAY --> CHW
```

### Core Components

- **app/(public)/card/[id]**: public, read-only emergency page — the page a QR code points to
- **app/(auth)/profile**: authenticated profile editor where a patient manages their private record
- **lib/supabase/**: Supabase client/server helpers and hand-authored types for the off-chain encrypted store
- **lib/stellar/**: Soroban attestation lookup — `getAttestation(recordHash)` calls the deployed `lafiya-contracts` registry over RPC when `ATTESTATION_CONTRACT_ID` is set, and falls back to an in-memory mock otherwise
- **lib/qr/**: QR code generation for the emergency page

### Offline support

The public card page is the product surface that matters most precisely where there is _no_ network — a responder scanning a QR in a dead zone. It is a `force-dynamic` Server Component (it must read live Supabase data and must never be indexed), so on its own it cannot render without a connection. A service worker bridges that gap **without** changing the page's security or freshness model.

- **What is cached:** the rendered HTML of each `/card/[id]` page the responder has _actually opened while online_. Nothing is prefetched or speculatively cached — a card you haven't been shown is never stored.
- **Strategy:** _cache after a real visit_ (network-first with cache fallback). Every successful navigation stores the HTML plus the fetch time. When the network fails, the last cached copy is served. Only `2xx` responses are cached; `404`s from `notFound()` (malformed or unknown id) and server errors are never stored, so a stale "not found" is never served from cache.
- **Staleness is explicit:** when a cached copy is served, the worker injects a visible `Showing cached data as of <time>` banner (inline-styled so it shows even before the app's stylesheet loads). A responder always knows they are looking at last-known data, not a live record.
- **Legibility offline:** the stylesheets referenced by card pages are cached separately (cache-first) so a cached card stays readable; JavaScript chunks are intentionally _not_ cached, which keeps the page from re-hydrating offline and silently dropping the injected banner.
- **Scope:** the worker is registered for the whole origin (so it is active before the first card visit) but its fetch handler only acts on `/card/*` navigations and card stylesheets — auth pages, the API, and every other route pass through untouched.

Implementation: `public/sw.js` (the worker), `public/offline-cache-helpers.js` (pure banner/injection helpers, unit-tested), and `app/offline-register.tsx` (registers the worker from the root layout, skipped in development).

> **Composes with the wider offline epic.** This is the service-worker half of Lafiya's offline support. The companion pieces — a PWA manifest and a client-side card-data cache — slot in around the same `/card/*` boundary; see the issue batch. The service worker alone already satisfies "a previously-viewed card renders offline with a visible staleness indicator."

The Soroban attestation registry, attester allowlist, and CHW verifier tool live in the `lafiya-contracts` and `lafiya-verifier` repos respectively — see [Lafiya Organization](#lafiya-organization).

## Attestation & Trust Layer

Lafiya Proof is the Stellar-native trust and payment layer underneath the Lafiya Card:

| Layer                   | Mechanism                                                                       | What it guarantees                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attestation**         | Soroban on-chain record: hash of the record + attester's identity + a timestamp | A responder can cryptographically confirm a real, allowlisted health worker verified this exact record, without the data ever being exposed |
| **Incentive rails**     | USDC on Stellar, paid per verified registration                                 | Near-zero-fee, cross-border micropayments make last-mile CHW outreach economically viable                                                   |
| **Transparent funding** | Grant and donor funds flow on-chain into the CHW incentive pool                 | Every donated dollar maps to a countable, auditable number of verified cards                                                                |

> **Core design principle.** No personal health data ever touches the blockchain. Personal data lives in an encrypted, access-controlled off-chain database. Stellar holds only hashes, attestations, and payments. This is what keeps Lafiya both privacy-respecting and regulator-compatible — and it is why Stellar is a _core_ component here, not a database substitute.

### Why Stellar (core, not shoehorned)

Stellar/Soroban does two things Lafiya genuinely needs that a plain web app cannot: it makes verification tamper-evident and independently checkable without exposing data, and it moves stablecoin micropayments to health workers cheaply and across borders. Remove Stellar and the trust layer and the incentive engine both disappear.

## Soroban Smart Contract Layer

The Soroban contract is the on-chain trust layer for Lafiya attestations — planned for `lafiya-contracts`, landing with milestone **M1**.

### Contract Functions (planned)

- `attest(record_hash: BytesN<32>, attester: Address, timestamp: u64)` - registers an attestation for a record hash (allowlisted attester only)
- `get_attestation(record_hash: BytesN<32>) -> Attestation` - read-only; returns the most recent attestation for a record hash, callable by any verifier
- `is_allowlisted(attester: Address) -> bool` - read-only; checks whether an address is a registered health worker

```rust
// Planned Soroban interface (Rust pseudocode) — lands with lafiya-contracts, M1
pub struct Attestation {
    pub record_hash: BytesN<32>,  // hash of the patient record; never the data itself
    pub attester: Address,        // allowlisted health worker's Stellar address
    pub timestamp: u64,           // ledger timestamp of the attestation
}
```

This composability lets a responder's scanner, or any other Stellar-aware verifier, confirm a record was attested by a real, allowlisted health worker — without an external oracle and without ever seeing the health data.

**M1 handoff point.** This repo already has the pieces that plug into the contract above: `lib/attestation/recordHash.ts` computes the deterministic hash a `lafiya-contracts` call would use, and `lib/stellar/attestation.ts` exposes a `getAttestation(recordHash)` function with the signature the real Soroban call has. The body now performs a read-only `simulateTransaction` against `get_attestation` on the deployed `lafiya-contracts` registry (via the Stellar SDK) whenever `ATTESTATION_CONTRACT_ID` is configured, and falls back to the original in-memory mock when it isn't set — so the public card page and the attestation Route Handler need no changes. A missing/unattested record hash reverts in-contract and is returned as `null` (not verified).

## Data Model (Emergency Subset)

The public emergency page is intentionally minimal:

- Name, age, photo
- **Blood group and genotype**
- Drug allergies
- Current medications (esp. anticoagulants, insulin, anti-epileptics)
- Chronic conditions / implants
- Emergency contact(s)
- Language spoken

Everything else (full history, documents, notes) stays private, behind authentication.

## Privacy & Compliance

- **Nigeria Data Protection Act (2023)** governs all personal data held. Consent, encryption, and minimal disclosure are designed in from day one.
- Patients opt into exactly what appears on their public page.
- No health data on-chain; only non-reversible hashes and attestations.

For the current threat model, access paths, and accepted tradeoffs across the public card, attestation lookup, avatars bucket, and authenticated profile editor, see the shared document in the separate docs repo: [lafiya-docs threat model](../lafiya-docs/threat-model.md).

## Repository Structure

This repository (`lafiya-web`) contains the patient + responder web app. The Soroban contracts, docs, and CHW verifier tool live in separate repos — see [Lafiya Organization](#lafiya-organization) below.

```
lafiya-web/
│
├── README.md
├── package.json
├── .env.example                  ← Config template (real values go in .env.local, gitignored)
├── .env.test                     ← Fixed local-only Supabase demo keys for integration tests
├── next.config.ts
├── proxy.ts                      ← Session refresh + route protection (Next 16's "middleware")
├── vitest.config.ts              ← Unit/component tests (jsdom)
├── vitest.integration.config.ts  ← Integration tests (node, against a running `supabase start`)
│
├── .github/workflows/ci.yml
│
├── supabase/
│   ├── config.toml
│   ├── seed.sql                  ← Demo patient fixture for local dev
│   └── migrations/                ← profiles table + RLS, get_emergency_card RPC, avatars bucket
│
├── app/
│   ├── page.tsx                  ← Landing page
│   ├── (public)/card/[id]/       ← Public, read-only emergency page (QR target)
│   ├── (auth)/
│   │   ├── signup/ signin/ signout/
│   │   └── profile/              ← Authenticated profile editor (identity, blood group/genotype,
│   │                                allergies/medications, chronic conditions, emergency contacts,
│   │                                photo upload, QR + link display)
│   └── api/attestation/[recordHash]/  ← Read-only attestation lookup Route Handler
│
├── lib/
│   ├── env.ts                    ← zod-validated environment config
│   ├── supabase/                 ← Client/server helpers + hand-authored Database types
│   ├── validation/                ← Profile form zod schema
│   ├── qr/                       ← QR code generation
│   ├── attestation/               ← Record-hash canonicalization + types
│   ├── stellar/                  ← Pre-M1 attestation stub
│   └── url/                      ← Request-derived base URL helper
│
└── tests/
    ├── setup.ts
    └── integration/               ← RLS + RPC tests against a real local Supabase
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start local Supabase and configure environment

```bash
npx supabase start
cp .env.example .env.local
```

`supabase start` prints an `ANON_KEY` and `SERVICE_ROLE_KEY` — put those (and the printed `API_URL`, usually `http://127.0.0.1:54321`) into `.env.local` as `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. `supabase db reset` applies migrations and seeds one demo patient (`demo@lafiya.test` / `lafiya-demo-password`, card id `11111111-1111-1111-1111-111111111111`) for local testing. See [Lafiya Organization](#lafiya-organization) for what each variable is for.

### 3. Run the dev server

```bash
npm run dev
```

Visit `/signup` to create a card, `/profile` to edit it, or `/card/11111111-1111-1111-1111-111111111111` to see the seeded demo patient's public emergency page.

## Testing

```bash
npm test               # unit + component tests (Vitest + React Testing Library, jsdom)
npx supabase start     # required once, before integration tests
npm run test:integration  # RLS + RPC tests against real local Postgres
```

- [x] Public emergency page renders only the patient-selected subset
- [x] Row-Level Security policies enforce patient-only read/write access (plus a table-level GRANT, which RLS alone doesn't provide)
- [x] QR generation produces a valid, input-dependent data URL
- [x] Verified-indicator rendering for both the verified and not-yet-verified states
- [x] Attestation lookup Route Handler (`/api/attestation/[recordHash]`): valid/unknown hashes, regex boundary validation, and response shape stability
- [x] `get_emergency_card` RPC contract: valid id, unknown id, anon-callable, no extra columns leak
- [x] Service-worker offline helpers: banner injection + timestamp formatting are unit-tested (`tests/unit/offline-cache-helpers.test.ts`); end-to-end offline behaviour is covered by the manual protocol below

Run `npm run lint && npm run typecheck && npm run build` for the same checks CI runs on every push/PR (see `.github/workflows/ci.yml`).

### Offline support — manual test protocol

Service-worker behaviour can't be exercised under jsdom, so verify it in a real browser (Chromium/Firefox/Safari) against a running dev or preview build:

1. **Prerequisite:** `npm run dev` (or a production `npm run build && npm start`) with a reachable Supabase. Registration is skipped in `development` mode, so for the service worker to register, use a production build/start or temporarily force the register path.
2. **Warm the cache:** open `/card/11111111-1111-1111-1111-111111111111` while online. Confirm the page renders and DevTools ▸ Application ▸ Service Workers shows `sw.js` as activated, and Cache Storage ▸ `lafiya-cards-v1` holds an entry for that URL.
3. **Go offline:** in DevTools ▸ Network set "Offline" (or stop the network interface). Reload `/card/11111111-1111-1111-1111-111111111111`.
   - **Expected:** the card renders from cache, and a sticky amber banner reads `Showing cached data as of <time>. This may be out of date — verify with the patient or facility when you can.`
4. **Scope check:** while offline, try a card id you have _never_ opened (e.g. `/card/22222222-2222-2222-2222-222222222222`).
   - **Expected:** the "No cached card available" fallback, never a guessed/partial card. Caching only ever happens for cards you have actually visited.
5. **No stale "not found":** while online, open a non-existent id → `404`. Go offline and reload that same id → still `404` (errors are never cached), not a previously-cached card.
6. **Freshness:** go back online and reload → the banner disappears (live data, no injected banner).

## Roadmap

### M0 — Public Card _(testnet)_

- [x] Patient can create a profile via `lafiya-web` (auth, and a field-by-field editor: identity, blood group/genotype, allergies/medications, chronic conditions, up to 3 emergency contacts, optional photo)
- [x] Public, read-only emergency page reachable by QR, with a verified-indicator placeholder ahead of real M1 attestation
- [x] Unit, component, and integration test coverage, with CI on every push/PR
- [x] Offline-first emergency page: a service worker caches each visited `/card/[id]` and shows a "cached as of" indicator when read without a network — see [Architecture › Offline support](#offline-support)
- [ ] Deployed to Vercel against Stellar testnet config

### M1 — Attestation

- [ ] Soroban attestation registry deployed (`lafiya-contracts`) — owned by that repo; set `ATTESTATION_CONTRACT_ID` here once shipped
- [x] `lafiya-web` calls the real `get_attestation` Soroban function over RPC when `ATTESTATION_CONTRACT_ID` is set, falling back to the in-memory mock otherwise (`lib/stellar/attestation.ts`)
- [ ] Allowlisted attester can verify a record (contract-side; `lafiya-contracts`)
- [x] Card displays a verified indicator driven by the real attestation lookup (public card page + `/api/attestation/[recordHash]`)

### M2 — Incentives

- [ ] USDC-on-Stellar payout wired to attestation events
- [ ] CHW payout tracking

### M3 — Pilot

- [ ] Small, supervised field pilot
- [ ] Metrics: verified cards created, scan events

### M4 — Mainnet + Funding

- [ ] Mainnet deployment
- [ ] Transparent on-chain funding pool live

## Why This Matters for the Stellar Ecosystem

A health record that can't be trusted at the point of care is one that costs lives. Lafiya addresses this directly:

- **For patients and mothers** — a free card that speaks for them when they can't, without requiring technical expertise
- **For responders and clinicians** — a verified indicator they can trust on the spot, with no login and no facility call required
- **For community health workers** — a real, near-zero-fee income stream tied to verified registrations, solving last-mile distribution
- **For the Stellar Foundation and ecosystem** — a Digital Public Good that demonstrates Soroban attestations and stablecoin micropayments solving a real-world, life-or-death problem

Lafiya is built as an open-source **Digital Public Good** (SDG 3, Good Health and Well-being):

- **Primary:** Stellar Community Fund (SCF) — Build track
- **Bridge:** Registration against the Digital Public Goods Standard
- **Later:** DPG-aligned and public-goods streaming funders once real-world impact is demonstrable

## Dependencies

- Node.js 24+ / Next.js 16 (App Router) — deployed on Vercel
- Supabase (`@supabase/supabase-js`, `@supabase/ssr`) — Postgres, Auth, Storage, Row-Level Security
- `zod` — environment and form validation
- `qrcode` — QR code generation
- `@stellar/stellar-sdk` — Soroban RPC client used by `lib/stellar/attestation.ts` to read attestations (M1+)
- Vitest, React Testing Library — unit, component, and integration tests
- W3C Verifiable Credentials data model, HL7 FHIR — standards informing the data model (see [References](#references))

## License

**MIT** (OSI-approved; see [LICENSE](LICENSE)).

## Contributing

We welcome contributions to Lafiya! Please read our [Contributing Guide](CONTRIBUTING.md) for local setup, development guidelines, database migration instructions, and code conventions before submitting a pull request.

### Operations & Observability

Lafiya integrates structured JSON logging and Sentry error tracking for observability.

#### Rules for Logging

1. **Never Log Patient Health Data:** Under no circumstances should any field from the emergency data model or authentication credentials be logged.
2. **Central Redaction:** The logging utility (`lib/logging/logger.ts`) automatically and recursively redacts sensitive fields case-insensitively. This includes `name`, `age`, `dateOfBirth`/`date_of_birth`, `bloodGroup`/`blood_group`, `genotype`, `allergies`, `medications`, `chronicConditions`/`chronic_conditions`, `emergencyContacts`/`emergency_contacts`, `phone`, `relationship`, `language`, `photoUrl`/`photo_url`, `email`, and `password`.
3. **Structured JSON Logs:** All server logs must use the `logInfo` and `logError` wrapper functions from `@/lib/logging/logger` so that they are output as queryable structured JSON and sent to Sentry.

#### Sentry Configuration

To configure Sentry in your environment, define the following variables:

- `NEXT_PUBLIC_SENTRY_DSN` - Sentry client/server DSN endpoint.
- `SENTRY_AUTH_TOKEN` - (Optional) Sentry build-time authentication token. If not provided, source map uploads are dynamically disabled during builds to prevent compilation failure.

## Lafiya Organization

This project lives under the `lafiya-xyz` GitHub organization. This repo is one of five. If a change here touches a shared contract (below), call it out so the matching repo can be updated.

| Repo                                                                   | Role                                                                                      | Primary language     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------- |
| [`.github`](https://github.com/lafiya-xyz/.github)                     | Organization profile README and contribution guidelines                                   | Markdown             |
| [`lafiya-docs`](https://github.com/lafiya-xyz/lafiya-docs)             | Concept note, data model, threat model, privacy design, funding/DPG materials, references | Markdown             |
| [`lafiya-web`](https://github.com/lafiya-xyz/lafiya-web) _(this repo)_ | Patient + responder web app. Public emergency page, authed profile editor, QR generation  | TypeScript (Next.js) |
| [`lafiya-contracts`](https://github.com/lafiya-xyz/lafiya-contracts)   | Soroban smart contracts (Rust): attestation registry + attester allowlist. Testnet first  | Rust (Soroban)       |
| [`lafiya-verifier`](https://github.com/lafiya-xyz/lafiya-verifier)     | CHW verification tool. Begins as a route inside `lafiya-web`; split out only if it grows  | TypeScript (planned) |

> Resist scaffolding empty repos. Two working repos (`lafiya-web`, `lafiya-contracts`) beat five half-built ones. Build one honest milestone at a time.

### Data Flow

```
lafiya-docs        ──(data model, threat model)──▶  lafiya-web
                                                        │
   patient input ──(profile data)──▶                   │  (Supabase, encrypted)
                                                        │
                                                        ▼
                                          Public emergency page (QR)
                                                        │
                        ┌───────────────────────────────┴───────────────────────────────┐
                        ▼                                                               ▼
              lafiya-contracts (Soroban)                                    lafiya-verifier (CHW tool)
                        │                                                               │
                        ▼                                                               ▼
        On-chain attestation + USDC payout                          Responder scans QR, sees verified flag
```

### Shared Contracts (must stay in sync across repos)

**1. Attestation schema** — a hash of the record + the attester's identity + a timestamp, defined conceptually here and mirrored by `lafiya-contracts`'s on-chain `Attestation` struct:

```
Attestation {
    record_hash: BytesN<32>   // hash of the patient record; never the data itself
    attester:    Address       // allowlisted health worker's Stellar address
    timestamp:   u64           // ledger timestamp of the attestation
}
```

If you change a field name, type, or hashing scheme here, update the Rust struct in `lafiya-contracts` in the same change set (or open a tracked follow-up in each repo).

**2. Emergency data model** — the field list in [Data Model](#data-model-emergency-subset) is the canonical decision-relevant subset. `lafiya-docs` mirrors it in the full data model / threat model; changing a field name here requires an update there.

**3. Environment variables / config keys** — `.env.example` defines the cross-repo keys:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the off-chain encrypted store; safe for the browser, scoped by RLS
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, bypasses RLS; never exposed to the browser
- `STELLAR_NETWORK_PASSPHRASE` — must match the network the contracts are deployed on
- `SOROBAN_RPC_URL` — Soroban RPC endpoint (testnet first)
- `ATTESTATION_CONTRACT_ID` — the deployed `lafiya-contracts` attestation registry contract id. **Optional:** when unset (local dev, CI, pre-deploy), `getAttestation` serves the in-memory mock so the verified indicator still renders

### Open Integration Points (not yet implemented)

- How `lafiya-web` calls `lafiya-contracts` — direct Soroban RPC from the app vs. a thin backend service
- How the attester allowlist is managed and updated — governance model not yet decided
- The exact USDC payout trigger — per attestation event vs. batched payouts

### Conventions for AI Agents

An agent working in only one of the five repos above can't see the others' code, so this section exists to orient one dropped into any single repo without prior context:

- Treat this section as the source of truth for **cross-repo** contracts. Each repo's own README covers repo-local conventions.
- When a change in this repo affects a shared contract above, call it out explicitly so the corresponding change can be made in the other repo(s) — don't silently assume it'll happen separately.
- Never let personal health data reach an on-chain call — only hashes, attester identity, and timestamps belong in `lafiya-contracts` calls. This is a hard invariant, not a style preference.
- Keep attestation and health-record field names identical (same casing, same units) across TypeScript (`web`), Rust (`contracts`), and Markdown (`docs`) — translation layers are a common source of bugs.
- If you land in `lafiya-docs`, read its data model doc before touching any patient-data field name anywhere in the org. If you land in `lafiya-contracts`, read the `Attestation` struct definition before changing the hash/attester/timestamp shape. If you land in `lafiya-verifier`, note it currently lives inside `lafiya-web` at `app/(auth)/profile` and the attestation-lookup code, not as a standalone repo yet.

## Support

For issues and questions:

- GitHub Issues: [Create an issue](https://github.com/lafiya-xyz/lafiya-web/issues)
- SECURITY policy: [SECURITY.md](SECURITY.md)

## Testing

- `npm test` — unit/component tests (Vitest, jsdom)
- `npm run test:integration` — Supabase RLS/RPC integration tests against a local `supabase start` instance
- `npm run test:e2e` — Playwright end-to-end tests covering the full patient journey: signup → profile save → QR/link retrieval → unauthenticated public card view. Requires a local Supabase instance (`supabase start`) and a built/running app (handled automatically by `playwright.config.ts`'s `webServer`).

## Disclaimer

Lafiya is an information aid, **not a medical device** and **not a substitute for professional medical judgment**. Verified indicators reflect that a record was attested by a registered health worker; they are not a clinical guarantee. Treatment decisions remain the responsibility of the attending clinician.

## References

These works directly informed Lafiya's design and are the intended reading for contributors.

**Books**

- Shortliffe, E. H., & Cimino, J. J. (Eds.). (2021). _Biomedical Informatics: Computer Applications in Health Care and Biomedicine_ (5th ed.). Springer. — Grounds the clinical data model: which fields are decision-relevant in an emergency, and how health records are structured and coded.
- Preukschat, A., & Reed, D. (2021). _Self-Sovereign Identity: Decentralized Digital Identity and Verifiable Credentials_. Manning. — The blueprint for Lafiya Proof: issuer/holder/verifier roles, verifiable credentials, hash-based attestation, key management, and offline verification.
- Toyama, K. (2015). _Geek Heresy: Rescuing Social Change from the Cult of Technology_. PublicAffairs. — Keeps the project honest: technology amplifies human capacity rather than replacing it, which is why Lafiya centers community health workers, not the app.
- Kleppmann, M. (2017). _Designing Data-Intensive Applications_. O'Reilly. — Informs the off-chain data layer: reliable and secure storage, encryption, and the boundary between what lives in the database and what is anchored on-chain.
- Martin, R. C. (2017). _Clean Architecture: A Craftsman's Guide to Software Structure and Design_. Prentice Hall. — Discipline for an AI-assisted codebase: clear boundaries so the app, the contracts, and the data layer stay independently maintainable.

**Standards & documentation**

- Stellar Development Foundation — Stellar and Soroban developer documentation.
- W3C — Verifiable Credentials Data Model.
- HL7 — FHIR (health-data interoperability standard).
- Nigeria Data Protection Act (2023) — Nigeria Data Protection Commission.
- Digital Public Goods Alliance — DPG Standard.

---

<div align="center">

**Lafiya** — Your vitals, verified. When you can't speak, Lafiya does.

_Built for the Stellar ecosystem. Open source. Community owned._

</div>
