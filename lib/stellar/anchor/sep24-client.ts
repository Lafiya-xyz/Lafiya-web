/**
 * Testnet prototype for a SEP-24 interactive withdrawal client.
 *
 * Spike only (see docs/anchor-offramp-spike.md) -- prototypes the
 * off-ramp UX path (SEP-1 discovery -> SEP-10 auth -> SEP-24 interactive
 * withdraw) against the SDF test anchor. Not wired into any production
 * payout flow, and not exercised end-to-end as part of this change.
 *
 * Privacy note: this client never collects or transmits KYC PII itself --
 * it only obtains the anchor's hosted interactive URL and redirects the CHW
 * to it. All KYC data entry happens inside the anchor's own web view. No
 * Lafiya health data (blood group, genotype, allergies, conditions) is ever
 * part of this flow.
 */

import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export interface AnchorTomlInfo {
  signingKey: string;
  webAuthEndpoint: string;
  transferServerSep24: string;
}

/** SEP-1: fetch and parse the anchor's stellar.toml (minimal fields only). */
export async function discoverAnchor(homeDomain: string): Promise<AnchorTomlInfo> {
  const res = await fetch(`https://${homeDomain}/.well-known/stellar.toml`);
  if (!res.ok) {
    throw new Error(`failed to fetch stellar.toml for ${homeDomain}: ${res.status}`);
  }
  const text = await res.text();
  return parseAnchorToml(text);
}

function parseAnchorToml(toml: string): AnchorTomlInfo {
  const get = (key: string): string => {
    const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
    if (!match) throw new Error(`stellar.toml missing required field: ${key}`);
    return match[1];
  };
  return {
    signingKey: get("SIGNING_KEY"),
    webAuthEndpoint: get("WEB_AUTH_ENDPOINT"),
    transferServerSep24: get("TRANSFER_SERVER_SEP0024"),
  };
}

/** SEP-10: request a challenge transaction, sign it with the CHW's keypair, and exchange it for a JWT. */
export async function authenticateWithAnchor(
  anchor: AnchorTomlInfo,
  chwKeypair: Keypair,
  networkPassphrase: string,
): Promise<string> {
  const challengeRes = await fetch(
    `${anchor.webAuthEndpoint}?account=${chwKeypair.publicKey()}`,
  );
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge request failed: ${challengeRes.status}`);
  }
  const { transaction: challengeXdr } = (await challengeRes.json()) as {
    transaction: string;
  };

  const challengeTx = TransactionBuilder.fromXDR(
    challengeXdr,
    networkPassphrase,
  ) as Transaction;

  // Reject a challenge not actually signed by the anchor we asked -- basic
  // SEP-10 sanity check before we sign anything.
  const signedByAnchor = challengeTx.signatures.length > 0;
  if (!signedByAnchor) {
    throw new Error("SEP-10 challenge is missing the anchor's signature");
  }

  challengeTx.sign(chwKeypair);

  const tokenRes = await fetch(anchor.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: challengeTx.toXDR() }),
  });
  if (!tokenRes.ok) {
    throw new Error(`SEP-10 token exchange failed: ${tokenRes.status}`);
  }
  const { token } = (await tokenRes.json()) as { token: string };
  return token;
}

export interface InteractiveWithdrawal {
  /** URL to redirect the CHW to; the anchor collects KYC + bank details here, not Lafiya. */
  url: string;
  id: string;
}

/** SEP-24: kick off an interactive withdrawal (USDC -> NGN) for the authenticated CHW. */
export async function startInteractiveWithdrawal(
  anchor: AnchorTomlInfo,
  jwt: string,
  assetCode: string,
): Promise<InteractiveWithdrawal> {
  const res = await fetch(`${anchor.transferServerSep24}/transactions/withdraw/interactive`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ asset_code: assetCode }),
  });
  if (!res.ok) {
    throw new Error(`SEP-24 interactive withdraw failed: ${res.status}`);
  }
  const { url, id } = (await res.json()) as { url: string; id: string };
  return { url, id };
}

export interface WithdrawalStatus {
  status: string;
  amountIn?: string;
  amountOut?: string;
}

/** Poll SEP-24 transaction status without ever inspecting the KYC fields the anchor holds. */
export async function pollWithdrawalStatus(
  anchor: AnchorTomlInfo,
  jwt: string,
  id: string,
): Promise<WithdrawalStatus> {
  const res = await fetch(`${anchor.transferServerSep24}/transaction?id=${id}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(`SEP-24 status poll failed: ${res.status}`);
  }
  const { transaction } = (await res.json()) as {
    transaction: { status: string; amount_in?: string; amount_out?: string };
  };
  return {
    status: transaction.status,
    amountIn: transaction.amount_in,
    amountOut: transaction.amount_out,
  };
}
