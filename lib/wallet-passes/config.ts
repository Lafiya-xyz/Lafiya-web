/**
 * @module wallet-passes/config
 *
 * Reads and validates the signing credentials needed to issue Apple/Google
 * wallet passes. Unlike `lib/runtime-config.ts`, this is deliberately *not*
 * called at process startup: wallet passes are an optional feature (issue
 * #538 lands the pass-generation code before any signing credential
 * exists), so an unconfigured deployment must keep booting and serving the
 * rest of the app. The cost of that choice is paid at the wallet routes
 * instead — see app/api/wallet/apple/route.ts and .../google/route.ts,
 * which call these getters and turn `WalletPassesNotConfiguredError` into a
 * clear 501 rather than ever emitting an unsigned or fake pass.
 */
import "server-only";

export class WalletPassesNotConfiguredError extends Error {
  constructor(
    readonly platform: "apple" | "google",
    readonly missing: string[],
  ) {
    super(
      `Wallet passes for ${platform} are not configured on this deployment ` +
        `(missing: ${missing.join(", ")}). See docs/wallet-passes.md for ` +
        "the credentials required to enable this feature. Refusing to " +
        "generate an unsigned pass.",
    );
    this.name = "WalletPassesNotConfiguredError";
  }
}

export interface AppleWalletSigningConfig {
  /** PEM-encoded pass-type signing certificate issued by the Apple
   * Developer portal, base64-encoded for safe storage in an env var. */
  signerCertBase64: string;
  /** PEM-encoded private key matching the certificate above, base64. */
  signerKeyBase64: string;
  /** Passphrase for the private key, if it is encrypted. */
  signerKeyPassphrase?: string;
  /** Apple Worldwide Developer Relations intermediate certificate, base64. */
  wwdrCertBase64: string;
  /** The registered Pass Type ID, e.g. "pass.xyz.lafiya.emergency". */
  passTypeIdentifier: string;
  /** Apple Developer Team ID. */
  teamIdentifier: string;
}

export interface GoogleWalletSigningConfig {
  /** Full service-account JSON key (as issued by Google Cloud), stored as a
   * single-line env var. */
  serviceAccountJson: string;
  /** Google Wallet issuer account ID. */
  issuerId: string;
  /** ID of the generic pass class created once via the Google Wallet API. */
  classId: string;
}

function readEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * @throws {WalletPassesNotConfiguredError} if any required Apple signing
 *   variable is unset. Never returns a partially-filled config.
 */
export function getAppleWalletConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppleWalletSigningConfig {
  const fields = {
    signerCertBase64: readEnv("APPLE_WALLET_SIGNER_CERT_BASE64", env),
    signerKeyBase64: readEnv("APPLE_WALLET_SIGNER_KEY_BASE64", env),
    wwdrCertBase64: readEnv("APPLE_WALLET_WWDR_CERT_BASE64", env),
    passTypeIdentifier: readEnv("APPLE_WALLET_PASS_TYPE_IDENTIFIER", env),
    teamIdentifier: readEnv("APPLE_WALLET_TEAM_IDENTIFIER", env),
  };
  const missing = Object.entries(fields)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new WalletPassesNotConfiguredError("apple", missing);
  }
  return {
    signerCertBase64: fields.signerCertBase64!,
    signerKeyBase64: fields.signerKeyBase64!,
    signerKeyPassphrase: readEnv("APPLE_WALLET_SIGNER_KEY_PASSPHRASE", env),
    wwdrCertBase64: fields.wwdrCertBase64!,
    passTypeIdentifier: fields.passTypeIdentifier!,
    teamIdentifier: fields.teamIdentifier!,
  };
}

/**
 * @throws {WalletPassesNotConfiguredError} if any required Google Wallet
 *   signing variable is unset. Never returns a partially-filled config.
 */
export function getGoogleWalletConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleWalletSigningConfig {
  const fields = {
    serviceAccountJson: readEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_JSON", env),
    issuerId: readEnv("GOOGLE_WALLET_ISSUER_ID", env),
    classId: readEnv("GOOGLE_WALLET_CLASS_ID", env),
  };
  const missing = Object.entries(fields)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new WalletPassesNotConfiguredError("google", missing);
  }
  return {
    serviceAccountJson: fields.serviceAccountJson!,
    issuerId: fields.issuerId!,
    classId: fields.classId!,
  };
}
