/**
 * @module wallet-passes/google
 *
 * Builds an "Add to Google Wallet" save link for the Lafiya emergency card.
 *
 * Google Wallet passes don't need a signed binary artifact like Apple's
 * `.pkpass` — the client just opens a URL of the form
 * `https://pay.google.com/gp/v/save/<JWT>`, where the JWT embeds the pass
 * object and is signed with the issuer's service-account private key
 * (RS256). Requires `jsonwebtoken` (listed in package.json — see
 * docs/wallet-passes.md; not yet installed/exercised here, since no real
 * Google Wallet service account exists in this environment).
 */
import "server-only";

import { getGoogleWalletConfig } from "./config";
import { buildGoogleWalletObject, buildWalletPassContent } from "./passContent";

const GOOGLE_WALLET_SAVE_BASE_URL = "https://pay.google.com/gp/v/save/";

/**
 * Builds the "Add to Google Wallet" save URL for `capabilityUrl`.
 *
 * @throws {WalletPassesNotConfiguredError} if Google Wallet signing
 *   credentials are not present in the environment. This is the only
 *   failure mode for a missing configuration — there is no fallback that
 *   returns an unsigned or placeholder link.
 * @throws {InvalidCapabilityUrlError} if `capabilityUrl` is not a
 *   capability-share link.
 */
export async function generateGoogleWalletSaveUrl(
  capabilityUrl: string,
): Promise<string> {
  const config = getGoogleWalletConfig();
  const content = buildWalletPassContent(capabilityUrl);
  const genericObject = buildGoogleWalletObject(
    content,
    config.issuerId,
    config.classId,
  );

  const signedJwt = await signGoogleWalletJwt(genericObject);
  return `${GOOGLE_WALLET_SAVE_BASE_URL}${signedJwt}`;
}

/**
 * Isolated so the signing call (the part that genuinely needs
 * `jsonwebtoken` and a real service-account key) can be swapped/mocked
 * without touching the pure `buildGoogleWalletObject` projection above.
 *
 * NOT implemented against a real service account in this environment — see
 * docs/wallet-passes.md. Wiring this up is: parse
 * `JSON.parse(config.serviceAccountJson)` for `client_email`/`private_key`,
 * build the JWT claims (`iss`, `aud: "google"`, `typ: "savetowallet"`,
 * `iat`, `payload: { genericObjects: [genericObject] }`), and sign with
 * `jsonwebtoken.sign(claims, private_key, { algorithm: "RS256" })`.
 */
async function signGoogleWalletJwt(
  genericObject: ReturnType<typeof buildGoogleWalletObject>,
): Promise<string> {
  void genericObject;
  throw new Error(
    "Google Wallet JWT signing is not implemented in this environment — " +
      "jsonwebtoken is listed as a dependency but has not been installed " +
      "or wired to a real service-account key. See docs/wallet-passes.md.",
  );
}
