import { describe, expect, it } from "vitest";

import { getProtocolRuntimeConfig } from "./config";

describe("CHW protocol runtime configuration", () => {
  it("refuses production mock mode and incomplete live protocol configuration", () => {
    expect(() =>
      getProtocolRuntimeConfig({
        NODE_ENV: "production",
        LAFIYA_DEPLOYMENT_ENV: "production",
        ATTESTATION_MODE: "mock",
      }),
    ).toThrow("PRODUCTION_MOCK_FORBIDDEN");
    expect(() =>
      getProtocolRuntimeConfig({
        NODE_ENV: "production",
        LAFIYA_DEPLOYMENT_ENV: "production",
        ATTESTATION_MODE: "live",
      }),
    ).toThrow("PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE");
  });

  it("requires an explicit CI identity for a mock production build", () => {
    expect(() => getProtocolRuntimeConfig({ NODE_ENV: "production" })).toThrow(
      "PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE",
    );
    expect(
      getProtocolRuntimeConfig({
        NODE_ENV: "production",
        LAFIYA_DEPLOYMENT_ENV: "ci",
        ATTESTATION_MODE: "mock",
      }),
    ).toMatchObject({ deployment: "ci", attestationMode: "mock" });
  });
});
