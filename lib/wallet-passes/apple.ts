/**
 * @module wallet-passes/apple
 *
 * Generates a signed `.pkpass` archive for the Lafiya emergency card.
 *
 * Requires `passkit-generator` (listed in package.json — see
 * docs/wallet-passes.md; not yet installed/exercised in this environment,
 * since no real Apple signing certificate exists here). The signing
 * certificate, private key, and WWDR intermediate never touch disk as
 * plaintext: they are read from base64 env vars (`getAppleWalletConfig`)
 * and passed to the library in memory.
 */
import "server-only";

import {
  getAppleWalletConfig,
  type AppleWalletSigningConfig,
} from "./config";
import { buildApplePassJson, buildWalletPassContent } from "./passContent";

/**
 * Builds and signs a `.pkpass` archive for `capabilityUrl`.
 *
 * @throws {WalletPassesNotConfiguredError} if Apple signing credentials are
 *   not present in the environment. This is the only failure mode for a
 *   missing configuration — there is no fallback that returns an unsigned
 *   or placeholder pass.
 * @throws {InvalidCapabilityUrlError} if `capabilityUrl` is not a
 *   capability-share link.
 */
export async function generateApplePass(
  capabilityUrl: string,
): Promise<Buffer> {
  const config = getAppleWalletConfig();
  const content = buildWalletPassContent(capabilityUrl);
  const passJson = buildApplePassJson(
    content,
    config.passTypeIdentifier,
    config.teamIdentifier,
  );

  return signApplePass(passJson, config);
}

/**
 * Isolated so the signing call (the part that genuinely needs
 * `passkit-generator` and real certificates) can be swapped/mocked without
 * touching the pure `buildApplePassJson` projection above.
 *
 * NOT implemented against a real certificate in this environment — see
 * docs/wallet-passes.md. Wiring this up is: construct a
 * `PKPass.from({...certificates}, passJson)` (per passkit-generator's API)
 * using `Buffer.from(config.signerCertBase64, "base64")` etc. for the
 * cert/key/WWDR, add the QR barcode + icon assets, and return
 * `pass.getAsBuffer()`.
 */
async function signApplePass(
  passJson: ReturnType<typeof buildApplePassJson>,
  config: AppleWalletSigningConfig,
): Promise<Buffer> {
  void passJson;
  void config;
  throw new Error(
    "Apple Wallet pass signing is not implemented in this environment — " +
      "passkit-generator is listed as a dependency but has not been " +
      "installed or wired to a real signing certificate. See " +
      "docs/wallet-passes.md.",
  );
}
