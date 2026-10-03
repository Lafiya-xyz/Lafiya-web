import { NextRequest, NextResponse } from 'next/server';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
  SorobanRpc,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';

export const runtime = 'nodejs';

const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

// Policy: only sponsor invocations of the attestation contract's `attest`.
const ATTESTATION_CONTRACT_ID = process.env.ATTESTATION_CONTRACT_ID ?? '';
const ATTEST_FUNCTION_NAME = 'attest';

// Policy: cap the fee the sponsor is willing to pay (in stroops).
const MAX_SPONSORED_FEE = BigInt(
  process.env.SPONSOR_MAX_FEE_STROOPS ?? '1000000',
);

// Policy: per-CHW daily quota of sponsored transactions.
const DAILY_QUOTA = Number(process.env.SPONSOR_DAILY_QUOTA ?? '50');

// Server-only sponsor key. Never expose this to the client.
function getSponsorKeypair(): Keypair {
  const secret = process.env.SPONSOR_SECRET_KEY;
  if (!secret) {
    throw new Error('SPONSOR_SECRET_KEY is not configured');
  }
  return Keypair.fromSecret(secret);
}

// In-memory quota ledger keyed by CHW public key. In production this should be
// backed by the audit table so quotas survive restarts and multiple instances.
const quotaLedger = new Map<string, { day: string; count: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkAndConsumeQuota(chw: string): boolean {
  const day = today();
  const entry = quotaLedger.get(chw);
  if (!entry || entry.day !== day) {
    quotaLedger.set(chw, { day, count: 1 });
    return true;
  }
  if (entry.count >= DAILY_QUOTA) {
    return false;
  }
  entry.count += 1;
  return true;
}

interface PolicyResult {
  ok: boolean;
  reason?: string;
  source?: string;
}

// Validate the inner transaction against the sponsorship policy:
// 1. It must be a Soroban transaction invoking the attestation contract.
// 2. The invoked function must be `attest`.
// 3. The fee must not exceed the sponsor's cap.
function enforcePolicy(tx: Transaction): PolicyResult {
  if (BigInt(tx.fee) > MAX_SPONSORED_FEE) {
    return { ok: false, reason: 'fee_exceeds_cap' };
  }

  const op = tx.operations[0];
  if (!op || op.type !== 'invokeHostFunction') {
    return { ok: false, reason: 'not_invoke_host_function' };
  }

  const hostFn = (op as { func?: xdr.HostFunction }).func;
  const invokeContract = hostFn?.invokeContract?.();
  if (!invokeContract) {
    return { ok: false, reason: 'not_contract_invocation' };
  }

  const contractId = StrKey.encodeContract(
    invokeContract.contractAddress().contractId(),
  );
  if (contractId !== ATTESTATION_CONTRACT_ID) {
    return { ok: false, reason: 'contract_not_allowlisted' };
  }

  const fnName = invokeContract.functionName().toString();
  if (fnName !== ATTEST_FUNCTION_NAME) {
    return { ok: false, reason: 'function_not_allowlisted' };
  }

  return { ok: true, source: tx.source };
}

export async function POST(req: NextRequest) {
  let body: { innerEnvelope?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { innerEnvelope } = body;
  if (!innerEnvelope || typeof innerEnvelope !== 'string') {
    return NextResponse.json(
      { error: 'missing_inner_envelope' },
      { status: 400 },
    );
  }

  let inner: Transaction;
  try {
    inner = TransactionBuilder.fromXDR(
      innerEnvelope,
      NETWORK_PASSPHRASE,
    ) as Transaction;
  } catch {
    return NextResponse.json(
      { error: 'invalid_inner_envelope' },
      { status: 400 },
    );
  }

  if (inner instanceof FeeBumpTransaction) {
    return NextResponse.json(
      { error: 'nested_fee_bump_not_allowed' },
      { status: 400 },
    );
  }

  const policy = enforcePolicy(inner);
  if (!policy.ok) {
    return NextResponse.json(
      { error: 'policy_rejected', reason: policy.reason },
      { status: 422 },
    );
  }

  const chw = policy.source!;
  if (!checkAndConsumeQuota(chw)) {
    return NextResponse.json(
      { error: 'quota_exceeded', quota: DAILY_QUOTA },
      { status: 429 },
    );
  }

  let sponsor: Keypair;
  try {
    sponsor = getSponsorKeypair();
  } catch {
    return NextResponse.json(
      { error: 'sponsor_not_configured' },
      { status: 500 },
    );
  }

  const server = new SorobanRpc.Server(RPC_URL);

  // Simulate the inner transaction before sponsoring it.
  try {
    const sim = await server.simulateTransaction(inner);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return NextResponse.json(
        { error: 'simulation_failed', detail: sim.error },
        { status: 422 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'simulation_unavailable' },
      { status: 502 },
    );
  }

  // Wrap the CHW-signed inner transaction in a fee bump paid by the sponsor.
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    MAX_SPONSORED_FEE.toString(),
    inner,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(sponsor);

  try {
    const result = await server.sendTransaction(feeBump);
    if (result.status === 'ERROR') {
      return NextResponse.json(
        { error: 'submit_failed', detail: result.errorResult?.toXDR('base64') },
        { status: 502 },
      );
    }
    return NextResponse.json({
      hash: result.hash,
      status: result.status,
    });
  } catch {
    return NextResponse.json({ error: 'submit_unavailable' }, { status: 502 });
  }
}
