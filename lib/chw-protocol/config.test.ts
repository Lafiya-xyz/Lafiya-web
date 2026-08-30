import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

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

  it("rejects a production config missing only the intent signing key (missing required field)", () => {
    // epochId is present, but CHW_PROTOCOL_INTENT_SIGNING_KEY is absent —
    // this must fail immediately and clearly, not silently fall back.
    expect(() =>
      getProtocolRuntimeConfig({
        NODE_ENV: "production",
        LAFIYA_DEPLOYMENT_ENV: "production",
        ATTESTATION_MODE: "live",
        CHW_PROTOCOL_EPOCH_ID: "epoch-42",
      }),
    ).toThrow("PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE");
  });

  it("rejects a production config missing only the epoch id (missing required field)", () => {
    // intentSigningKey is present, but CHW_PROTOCOL_EPOCH_ID is absent.
    expect(() =>
      getProtocolRuntimeConfig({
        NODE_ENV: "production",
        LAFIYA_DEPLOYMENT_ENV: "production",
        ATTESTATION_MODE: "live",
        CHW_PROTOCOL_INTENT_SIGNING_KEY: "S" + "A".repeat(55),
      }),
    ).toThrow("PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE");
  });

  it("rejects an ATTESTATION_MODE value that is not one of the known modes (wrong type)", () => {
    // A malformed/unexpected env value must fail fast with a schema error
    // that names the offending value, not silently coerce or default.
    let caught: unknown;
    try {
      getProtocolRuntimeConfig({
        NODE_ENV: "development",
        ATTESTATION_MODE: "not-a-real-mode",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect(() =>
      getProtocolRuntimeConfig({
        NODE_ENV: "development",
        ATTESTATION_MODE: "not-a-real-mode",
      }),
    ).toThrow(/not-a-real-mode/);
  });

  it("rejects a LAFIYA_DEPLOYMENT_ENV value outside the known deployment enum (wrong type)", () => {
    let caught: unknown;
    try {
      getProtocolRuntimeConfig({
        NODE_ENV: "development",
        LAFIYA_DEPLOYMENT_ENV: "not-a-real-deployment",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect(() =>
      getProtocolRuntimeConfig({
        NODE_ENV: "development",
        LAFIYA_DEPLOYMENT_ENV: "not-a-real-deployment",
      }),
    ).toThrow(/not-a-real-deployment/);
  });
});
