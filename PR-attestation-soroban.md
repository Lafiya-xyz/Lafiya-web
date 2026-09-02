# PR: Wire `getAttestation` to the real Soroban registry (M1 handoff)

## Summary

`lib/stellar/attestation.ts` was a pre-M1 in-memory mock of the `getAttestation(recordHash)`
function. The public card page and the `/api/attestation/[recordHash]` route were already
wired to that exact signature specifically so the real swap wouldn't touch callers. This
change performs that swap: when `ATTESTATION_CONTRACT_ID` is configured, `getAttestation`
now calls the deployed `lafiya-contracts` `get_attestation` Soroban function over RPC. When
it's unset (local dev, CI, pre-deploy), it keeps serving the original mock so the verified
indicator still renders.

## Changes

### `lib/stellar/attestation.ts`

- Added `@stellar/stellar-sdk` as a dependency (the Stellar SDK client pattern the README
  reserved for M1).
- `getAttestation(recordHash)` now:
  - Returns the mock attestation when `serverEnv.ATTESTATION_CONTRACT_ID` is unset
    (explicit, documented local-dev fallback).
  - Otherwise builds a read-only `get_attestation` invocation (`record_hash` as `BytesN<32>`),
    runs it through `rpc.Server.simulateTransaction` (no signing, no submission, no fee), and
    decodes the returned `Attestation` struct.
  - Treats a simulation error (an unattested/missing record hash reverts in-contract) and a
    missing return value as `null` — i.e. "not verified", matching the mock's contract.
  - Decodes defensively (`decodeAttestation`) so a malformed on-chain value can't silently
    poison the verified indicator; validates the `attester`/`timestamp` shape.
- The placeholder source `Account` is built lazily (only on the real path) so importing the
  module has no side effects and the mock fallback stays import-safe during `next build`.

### `app/(public)/card/[id]/page.tsx` and `app/api/attestation/[recordHash]/route.ts`

- **No changes.** Both still call `getAttestation(recordHash)` and read `attestation !== null`.

### `README.md`

- M1 roadmap: checked off the `lafiya-web` items (real RPC call + verified indicator driven by
  it); the contract-deployment and allowlisted-attester items stay in `lafiya-contracts`.
- Documented the `ATTESTATION_CONTRACT_ID` optional/local-dev fallback.
- Updated "Core Components" and Dependencies to reflect that `@stellar/stellar-sdk` is now a
  real dependency and the stub is live.

### Tests

- `tests/stellar-attestation.test.ts` — real-RPC path against a mocked SDK (recorded-RPC-fixture
  style): asserts the contract/method/bytes args, decodes a successful `Attestation`, and
  returns `null` for a simulation error or a missing return value.
- `tests/stellar-attestation-mock.test.ts` — local-dev mock fallback (no `ATTESTATION_CONTRACT_ID`):
  returns the demo attestation for the fixture hash and `null` for unknown hashes, and asserts
  the SDK is never invoked on this path.

## Verification

- `npm run lint` — passes.
- `npm run typecheck` — passes.
- `npm test` — 28 tests pass (incl. the 6 new attestation tests).
- `npm run build` — succeeds with the CI env (no `ATTESTATION_CONTRACT_ID` → mock fallback).

## Notes / coordination needed (cross-repo)

- This repo (`lafiya-web`) cannot deploy `lafiya-contracts`; the `ATTESTATION_CONTRACT_ID` env
  var must be set once that contract is deployed to testnet. The web-side swap is complete.
- The exact on-chain `Attestation` field names/casing depend on the `lafiya-contracts` spec;
  `decodeAttestation` is defensive (handles snake/camel casing and `bigint` timestamps) but
  should be confirmed against the real contract's return XDR during integration.
- Recommended follow-up: a recorded live-testnet fixture (or a `test:integration` against
  testnet with `ATTESTATION_CONTRACT_ID` set) to lock the exact shape against the deployed
  contract — the current unit tests cover shape/error-handling logic with a mocked SDK.
