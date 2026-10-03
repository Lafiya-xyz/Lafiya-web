import { NextRequest, NextResponse } from 'next/server';
import { Keypair, TransactionBuilder, Networks, WebAuth } from '@stellar/stellar-sdk';
import { consumeChallenge, verifyChallenge } from '@/lib/stellar/sep10';
import { getServerSigningKeypair, getHomeDomain, getWebAuthDomain } from '@/lib/stellar/sep10-config';
import { bindChwAddress } from '@/lib/stellar/chw-identity';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { transaction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const encoded = body?.transaction;
  if (!encoded || typeof encoded !== 'string') {
    return NextResponse.json({ error: 'missing_transaction' }, { status: 400 });
  }

  const serverKeypair = getServerSigningKeypair();
  const homeDomain = getHomeDomain();
  const webAuthDomain = getWebAuthDomain();

  let transaction;
  try {
    transaction = TransactionBuilder.fromXDR(encoded, Networks.PUBLIC);
  } catch {
    return NextResponse.json({ error: 'invalid_transaction' }, { status: 400 });
  }

  // Verify the challenge transaction against SEP-10 rules (home domain,
  // web_auth_domain, timebounds, server signature, client signature).
  let clientAccount: string;
  try {
    const { clientAccountID } = WebAuth.readChallengeTx(
      encoded,
      serverKeypair.publicKey(),
      Networks.PUBLIC,
      homeDomain,
      webAuthDomain,
    );
    clientAccount = clientAccountID;
  } catch {
    return NextResponse.json({ error: 'invalid_challenge' }, { status: 400 });
  }

  // Nonce replay protection: each challenge may be redeemed exactly once.
  const nonce = transaction.hash().toString('hex');
  const fresh = await consumeChallenge(nonce);
  if (!fresh) {
    return NextResponse.json({ error: 'challenge_already_used' }, { status: 400 });
  }

  // Confirm the client actually signed the challenge.
  try {
    WebAuth.verifyChallengeTxSigners(
      encoded,
      serverKeypair.publicKey(),
      Networks.PUBLIC,
      [clientAccount],
      homeDomain,
      webAuthDomain,
    );
  } catch {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  // Bind the proven address to the CHW identity / Supabase session.
  try {
    await bindChwAddress(clientAccount);
  } catch {
    return NextResponse.json({ error: 'binding_failed' }, { status: 500 });
  }

  const token = WebAuth.buildChallengeTx(
    Keypair.fromPublicKey(clientAccount),
    serverKeypair.publicKey(),
    homeDomain,
    0,
    webAuthDomain,
  );

  return NextResponse.json({
    token,
    account: clientAccount,
  });
}
