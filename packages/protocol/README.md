# @lafiya/protocol

Canonicalization, hashing, intent types, and attestation schemas for the Lafiya emergency health record protocol.

This package is the **single source of truth** for:
- Record canonicalization and HMAC commitment computation
- Emergency record data types and clinical field enumerations
- Attestation and intent types
- JSON Schemas for protocol data validation
- Test vectors for cross-repository verification

## Design constraints

- **No server-only or secret-handling code.** This package is safe to import from browsers, edge workers, Deno, Bun, and Node.js environments.
- **No PHI.** Types accept PHI-bearing values (they're health record shapes) but the package itself stores no patient data.
- **Portable HMAC.** The commitment computation uses `node:crypto` when available and falls back to the Web Crypto API.

## Installation

```bash
npm install @lafiya/protocol
```

## Usage

```typescript
import {
  canonicalizeEmergencyRecord,
  computeRevisionCommitment,
  type EmergencyRecordData,
} from "@lafiya/protocol";

const data: EmergencyRecordData = {
  name: "  Amina   Yusuf ",
  date_of_birth: "1998-04-03",
  photo_url: "https://example.invalid/avatar.jpg",
  language: " Hausa ",
  blood_group: "O+",
  genotype: "AS",
  allergies: ["Penicillin", " Latex ", "Penicillin"],
  medications: ["Insulin"],
  chronic_conditions: ["Asthma"],
  emergency_contacts: [
    { name: " Halima Yusuf ", phone: "0801 234 5678", relationship: " Mother " },
  ],
};

// Deterministic canonical JSON string (presentation-only fields excluded)
const canonical = canonicalizeEmergencyRecord(data);

// HMAC-SHA256 commitment (async, works in all runtimes)
const secretHex = "a".repeat(64); // 256-bit key from profile_secrets
const commitment = await computeRevisionCommitment(data, secretHex);
```

## Semver rules

Versioning is tied to `RECORD_SCHEMA_VERSION`:

| Bump | When |
| --- | --- |
| **PATCH** | Documentation or description changes only |
| **MINOR** | New optional fields; existing commitments remain valid |
| **MAJOR** | Canonical form changes; `RECORD_SCHEMA_VERSION` is incremented and all existing commitments are invalidated |

The CI release workflow verifies test vectors before publishing to prevent accidental commitment-breaking changes.

## Test vectors

Test vectors are in `src/test-vectors/` and cover the full canonicalization and commitment pipeline. They are also used by the contracts repo and CHW verifier tooling for independent cross-language verification.

```bash
npm test
```

## Build

```bash
npm run build
```

Outputs ESM (`dist/index.js`), CJS (`dist/index.cjs`), and TypeScript declarations (`dist/index.d.ts`).
