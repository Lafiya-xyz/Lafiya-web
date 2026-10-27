# Contracts changelog

Every published `contracts/*-vN.schema.json` is immutable with respect to
breaking changes. `npm run contracts:check` (run in CI on every PR touching
`contracts/`) classifies each schema change as compatible, backward-only,
forward-only or breaking. A breaking change must ship as a new
`*-vN+1.schema.json` file (with its `*-vN+1.json` test vector) and an entry
below that names the new file.

## chw-attestation-protocol-v1.schema.json

- Initial published version.

## record-canonicalization-v1.schema.json

- Initial published version.
