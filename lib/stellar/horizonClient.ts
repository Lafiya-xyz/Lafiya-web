import { Horizon } from '@stellar/stellar-sdk';

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ??
  process.env.HORIZON_URL ??
  'https://horizon.stellar.org';

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
  process.env.STELLAR_NETWORK_PASSPHRASE ??
  'Public Global Stellar Network ; September 2015';

/**
 * Shared Horizon server instance. Reused across requests so the SDK's
 * internal connection pool is not re-created on every call.
 */
export const horizonServer = new Horizon.Server(HORIZON_URL, {
  allowHttp: HORIZON_URL.startsWith('http://'),
});

export const horizonConfig = {
  url: HORIZON_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
} as const;

export interface AccountBalance {
  asset: string;
  balance: string;
}

/**
 * Fetch the native (XLM) balance for an account. Returns null when the
 * account does not exist on-chain yet.
 */
export async function getAccountBalance(
  accountId: string,
): Promise<AccountBalance | null> {
  try {
    const account = await horizonServer.loadAccount(accountId);
    const native = account.balances.find(
      (b) => b.asset_type === 'native',
    );
    if (!native) return null;
    return { asset: 'XLM', balance: native.balance };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Fetch the balance of a specific asset held by an account. Returns null
 * when the account or the trustline does not exist.
 */
export async function getAssetBalance(
  accountId: string,
  assetCode: string,
  assetIssuer: string,
): Promise<AccountBalance | null> {
  try {
    const account = await horizonServer.loadAccount(accountId);
    const match = account.balances.find(
      (b) =>
        'asset_code' in b &&
        b.asset_code === assetCode &&
        'asset_issuer' in b &&
        b.asset_issuer === assetIssuer,
    );
    if (!match) return null;
    return { asset: assetCode, balance: match.balance };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Return the latest ledger sequence number known to Horizon. Used to
 * stamp transparency aggregates with an "as of ledger N" marker.
 */
export async function getLatestLedgerSequence(): Promise<number> {
  const page = await horizonServer.ledgers().order('desc').limit(1).call();
  const latest = page.records[0];
  if (!latest) {
    throw new Error('Horizon returned no ledgers');
  }
  return latest.sequence;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as { response?: { status?: number } }).response?.status ===
      'number' &&
    (err as { response: { status: number } }).response.status === 404
  );
}
