/**
 * @lafiya/protocol/schemas
 *
 * JSON Schema exports for protocol data validation.
 * These schemas validate the test vector files and the contract JSON files
 * used across the Lafiya app, CHW verifier tooling, and contracts repo.
 */

export const recordCanonicalizationV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["contract", "version", "vectors"],
  properties: {
    contract: { const: "lafiya.record-commitment" },
    version: { const: 1 },
    vectors: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "secretHex", "input", "canonical", "commitment"],
        properties: {
          name: { type: "string" },
          secretHex: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
          input: {
            type: "object",
            required: [
              "name",
              "blood_group",
              "genotype",
              "allergies",
              "medications",
              "chronic_conditions",
              "emergency_contacts",
            ],
          },
          canonical: { type: "string" },
          commitment: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
        },
      },
    },
  },
} as const;

export const chwAttestationProtocolV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["contract", "version", "intents", "events"],
  properties: {
    contract: { const: "lafiya.chw-attestation-protocol" },
    version: { const: 1 },
    intents: { type: "array" },
    events: { type: "array" },
  },
} as const;
