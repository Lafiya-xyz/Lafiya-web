import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Issue #934: SMART App Launch (EHR launch) primitives.
 *
 * This module holds the pure, testable half of the flow: SMART
 * configuration discovery, launch-parameter validation, the signed
 * per-launch state cookie, and the minimal read-scope set Lafiya requests.
 * It never touches PHI and never logs launch tokens or patient ids.
 */

/** The only scopes Lafiya asks for: read-only card view. */
export const SMART_SCOPES = [
  "openid",
  "fhirUser",
  "launch/patient",
  "patient/Patient.read",
] as const;

export type SmartConfiguration = {
  authorization_endpoint: string;
  token_endpoint: string;
  capabilities: string[];
};

export type SmartLaunchParams = {
  iss: string;
  launch: string;
};

const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;
const STATE_TTL_SECONDS = 10 * 60;

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Validates the `iss` / `launch` query parameters of an EHR launch. */
export function parseLaunchParams(
  searchParams: URLSearchParams,
): SmartLaunchParams | null {
  const iss = searchParams.get("iss");
  const launch = searchParams.get("launch");
  if (!iss || !launch) return null;
  if (!isHttpsUrl(iss)) return null;
  if (!LAUNCH_TOKEN_PATTERN.test(launch)) return null;
  return { iss, launch };
}

/**
 * Fetches and validates the EHR's SMART configuration document
 * (`<iss>/.well-known/smart-configuration`). Returns null on any failure so
 * callers fail closed instead of falling back to a guessed endpoint.
 */
export async function fetchSmartConfiguration(
  iss: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmartConfiguration | null> {
  if (!isHttpsUrl(iss)) return null;
  const base = iss.endsWith("/") ? iss : `${iss}/`;
  let response: Response;
  try {
    response = await fetchImpl(new URL(".well-known/smart-configuration", base), {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;

  const doc = body as Record<string, unknown>;
  const authorizationEndpoint = doc.authorization_endpoint;
  const tokenEndpoint = doc.token_endpoint;
  if (
    typeof authorizationEndpoint !== "string" ||
    typeof tokenEndpoint !== "string" ||
    !isHttpsUrl(authorizationEndpoint) ||
    !isHttpsUrl(tokenEndpoint)
  ) {
    return null;
  }

  const capabilities = Array.isArray(doc.capabilities)
    ? doc.capabilities.filter((c): c is string => typeof c === "string")
    : [];

  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    capabilities,
  };
}

function stateKey(): Buffer {
  const secret = process.env.SMART_LAUNCH_STATE_SECRET;
  if (!secret) throw new Error("SMART_LAUNCH_STATE_SECRET is not configured");
  return Buffer.from(secret, "utf8");
}

function sign(payload: string): string {
  return createHmac("sha256", stateKey()).update(payload).digest("base64url");
}

/**
 * Builds the opaque `state` value sent to the EHR. It carries the launch
 * context (iss, launch token, nonce) signed with an HMAC so the callback can
 * verify it was issued by us without any server-side session store.
 */
export function createLaunchState(
  params: SmartLaunchParams,
  now: number = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      iss: params.iss,
      launch: params.launch,
      nonce: randomBytes(16).toString("base64url"),
      exp: Math.floor(now / 1000) + STATE_TTL_SECONDS,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export type VerifiedLaunchState = SmartLaunchParams & { nonce: string };

/** Verifies a `state` value produced by createLaunchState(). */
export function verifyLaunchState(
  state: string,
  now: number = Date.now(),
): VerifiedLaunchState | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const value = parsed as Record<string, unknown>;
  if (
    typeof value.iss !== "string" ||
    typeof value.launch !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.exp !== "number"
  ) {
    return null;
  }
  if (value.exp * 1000 <= now) return null;
  if (!isHttpsUrl(value.iss)) return null;
  if (!LAUNCH_TOKEN_PATTERN.test(value.launch)) return null;

  return { iss: value.iss, launch: value.launch, nonce: value.nonce };
}

/** Builds the EHR authorization URL for an EHR launch. */
export function buildAuthorizationUrl(
  config: SmartConfiguration,
  params: { state: string; redirectUri: string; clientId: string; launch: string },
): string {
  const url = new URL(config.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", SMART_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("aud", config.authorization_endpoint);
  url.searchParams.set("launch", params.launch);
