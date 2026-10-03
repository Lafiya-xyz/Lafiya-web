import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { Keypair, Networks, TransactionBuilder, Account, Operation, BASE_FEE } from '@stellar/stellar-sdk';

/**
 * SEP-10 challenge endpoint.
 *
 * GET /api/sep10/challenge?account=G...
 *
 * Returns a signed challenge transaction that the CHW wallet must sign and
 * submit to POST /api/sep10/token to prove control of their Stellar address.
 *
 * The challenge follows SEP-10:
 *  - source account is the server signing key
 *  - sequence number is 0
 *  - timebounds are [now, now + 15 minutes]
 *  - a single manageData operation with name `<home_domain> auth` and a
 *    random nonce value
 *  - the transaction is signed by the server signing key
 */

const HOME_DOMAIN = process.env.SEP10_HOME_DOMAIN ?? 'localhost';
const WEB_AUTH_DOMAIN = process.env.SEP10_WEB_AUTH_DOMAIN ?? HOME_DOMAIN;
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const CHALLENGE_TTL_SECONDS = 15 * 60;

function getServerKeypair(): Keypair {
  const secret = process.env.SEP10_SIGNING_SECRET;
  if (!secret) {
    throw new Error('SEP10_SIGNING_SECRET is not configured');
  }
  return Keypair.fromSecret(secret);
}

function isValidStellarAccount(account: string): boolean {
  try {
    Keypair.fromPublicKey(account);
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const account = request.nextUrl.searchParams.get('account');

  if (!account) {
    return NextResponse.json(
      { error: 'Missing required query parameter: account' },
      { status: 400 },
    );
  }

  if (!isValidStellarAccount(account)) {
    return NextResponse.json(
      { error: 'Invalid Stellar account' },
      { status: 400 },
    );
  }

  let serverKeypair: Keypair;
  try {
    serverKeypair = getServerKeypair();
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }

  const nonce = randomBytes(48).toString('base64');
  const now = Math.floor(Date.now() / 1000);

  const sourceAccount = new Account(serverKeypair.publicKey(), '-1');
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds: {
      minTime: now,
      maxTime: now + CHALLENGE_TTL_SECONDS,
    },
  })
    .addOperation(
      Operation.manageData({
        name: `${HOME_DOMAIN} auth`,
        value: nonce,
      }),
    )
    .addMemo(undefined as never)
    .build();

  transaction.sign(serverKeypair);

  return NextResponse.json(
    {
      transaction: transaction.toEnvelope().toXDR('base64'),
      network_passphrase: NETWORK_PASSPHRASE,
      web_auth_domain: WEB_AUTH_DOMAIN,
    },
    { status: 200 },
  );
}
