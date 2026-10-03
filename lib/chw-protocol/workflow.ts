import "server-only";

import { ProtocolError, type TrustState } from "./types";

export type VerificationRequestStatus =
  | "pending" | "leased" | "submitted" | "confirming" | "completed" | "failed" | "expired";

/** Public, non-clinical projection used by CHW and patient clients. */
export type VerificationStatus = "requested" | "processing" | "verified" | "failed";

/**
 * Reference model of the CHW verification intent state machine.
 *
 * The model is intentionally pure and side-effect free so it can be driven by
 * property-based tests (fast-check model-based testing) as well as by the
 * runtime projection below. It encodes the allowed commands and the invariants
 * that must hold after every transition:
 *
 *  - no double settlement: a request may only reach `completed` once;
 *  - terminal states (`completed`, `failed`, `expired`) are absorbing;
 *  - every transition is one of the explicitly allowed edges.
 */
export type VerificationCommand =
  | "create"
  | "attest-observed"
  | "finalize"
  | "invalidate"
  | "quarantine"
  | "release"
  | "settle";

export const TERMINAL_VERIFICATION_STATUSES: readonly VerificationRequestStatus[] = [
  "completed",
  "failed",
  "expired",
];

export function isTerminalVerificationStatus(status: VerificationRequestStatus): boolean {
  return TERMINAL_VERIFICATION_STATUSES.includes(status);
}

/** Allowed command transitions for the verification intent state machine. */
const VERIFICATION_TRANSITIONS: Record<
  VerificationRequestStatus,
  Partial<Record<VerificationCommand, VerificationRequestStatus>>
> = {
  pending: {
    "attest-observed": "leased",
    invalidate: "failed",
    quarantine: "failed",
    settle: "completed",
  },
  leased: {
    finalize: "submitted",
    invalidate: "failed",
    quarantine: "failed",
    release: "pending",
    settle: "completed",
  },
  submitted: {
    finalize: "confirming",
    invalidate: "failed",
    quarantine: "failed",
    settle: "completed",
  },
  confirming: {
    finalize: "completed",
    invalidate: "failed",
    quarantine: "failed",
    settle: "completed",
  },
  completed: {},
  failed: {},
  expired: {},
};

/**
 * Apply a command to a status, returning the next status or `null` when the
 * command is not allowed from the current state. Terminal states are absorbing
 * and therefore never yield a next status.
 */
export function applyVerificationCommand(
  status: VerificationRequestStatus,
  command: VerificationCommand,
): VerificationRequestStatus | null {
  if (isTerminalVerificationStatus(status)) return null;
  return VERIFICATION_TRANSITIONS[status][command] ?? null;
}

/**
 * Invariant check used by the model-based tests after every command.
 * Returns a list of violated invariant names (empty when the state is valid).
 */
export function checkVerificationInvariants(
  status: VerificationRequestStatus,
  settledCount: number,
): string[] {
  const violations: string[] = [];
  if (settledCount > 1) violations.push("no-double-settlement");
  if (isTerminalVerificationStatus(status) && settledCount > 1) {
    violations.push("terminal-absorbing");
  }
  return violations;
}

export function projectVerificationStatus(
  status: VerificationRequestStatus,
  trustState?: TrustState,
  now = new Date(),
  leaseExpiresAt?: string | null,
): VerificationStatus {
  if (status === "completed" || trustState === "verified") return "verified";
  if (status === "failed" || status === "expired" || trustState === "expired" || trustState === "revoked" || trustState === "conflicted") return "failed";
  if (status === "leased" && leaseExpiresAt && Date.parse(leaseExpiresAt) <= now.getTime()) return "failed";
  if (status === "leased" || status === "submitted" || status === "confirming" || trustState === "submitted" || trustState === "confirming") return "processing";
  return "requested";
}

export function assertCurrentRecordHash(expected: string, actual: string) {
  if (!/^[0-9a-f]{64}$/i.test(expected) || expected.toLowerCase() !== actual.toLowerCase()) {
    throw new ProtocolError("REQUEST_NOT_CURRENT");
  }
}

export function assertTransactionHash(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ProtocolError("INVALID_INTENT");
  return value.toLowerCase();
}

/**
 * Wallet-agnostic signing flow for CHW verification intents.
 *
 * The heavy `@creit.tech/stellar-wallets-kit` dependency is loaded lazily via
 * `loadWalletKit()` so it never enters the public card bundle. The flow is:
 *
 *   1. fetch the unsigned verification-intent transaction from the server,
 *   2. have the selected wallet sign it (Freighter, xBull, Lobstr, WalletConnect),
 *   3. submit the signed XDR back through the server, which runs a simulation
 *      preflight before broadcasting.
 *
 * No PHI or capability tokens are ever handed to the wallet: only the unsigned
 * XDR envelope and the public network passphrase cross the boundary.
 */

export type WalletId = "freighter" | "xbull" | "lobstr" | "walletconnect";

export type WalletNetwork = "PUBLIC" | "TESTNET" | "FUTURENET";

export interface UnsignedIntent {
  /** Base64-encoded unsigned transaction envelope. */
  xdr: string;
  /** Network the server expects the transaction to be signed for. */
  network: WalletNetwork;
  /** Public network passphrase matching `network`. */
  networkPassphrase: string;
}

export interface SignedIntent {
  xdr: string;
  /** Transaction hash returned by the server after preflight + submit. */
  hash: string;
}

/**
 * Minimal structural type for the lazily-loaded kit. Kept local so the server
 * module never statically imports the browser-only package.
 */
export interface WalletKitClient {
  setWallet(id: WalletId): Promise<void>;
  getPublicKey(): Promise<string>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; address?: string },
  ): Promise<{ signedTxXdr: string }>;
}

export interface WalletSigningDeps {
  /** Lazily resolves the wallet kit; must not be imported at module scope. */
  loadWalletKit: () => Promise<WalletKitClient>;
  /** Fetches the unsigned intent transaction from the server. */
  fetchUnsignedIntent: (requestId: string) => Promise<UnsignedIntent>;
  /** Submits the signed XDR; the server performs the simulation preflight. */
  submitSignedIntent: (requestId: string, signedXdr: string) => Promise<SignedIntent>;
}

/**
 * Maps raw wallet error codes/messages to actionable, user-facing copy.
 * Unknown errors fall back to a generic retry message rather than leaking
 * wallet internals to the CHW.
 */
export function mapWalletError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const code = raw.toLowerCase();

  if (code.includes("user declined") || code.includes("user rejected") || code.includes("rejected by user") || code.includes("declined")) {
    return "Signing was cancelled in your wallet. Approve the request to continue.";
  }
  if (code.includes("not connected") || code.includes("not installed") || code.includes("no wallet") || code.includes("wallet not found")) {
    return "We couldn't reach your wallet. Install or unlock it, then try again.";
  }
  if (code.includes("network mismatch") || code.includes("wrong network") || code.includes("network passphrase")) {
    return "Your wallet is on a different network than this verification. Switch networks in your wallet and retry.";
  }
  if (code.includes("timeout") || code.includes("timed out")) {
    return "Your wallet took too long to respond. Reopen it and try again.";
  }
  if (code.includes("insufficient") || code.includes("balance")) {
    return "Your wallet doesn't have enough funds to cover the network fee.";
  }
  return "We couldn't complete the signature. Please try again.";
}

/**
 * Throws a ProtocolError when the connected wallet's network does not match the
 * network the server expects for the intent. This is checked before signing so
 * the CHW gets a clear message instead of an opaque submission failure.
 */
export function assertWalletNetwork(
  wallet: { network: string; networkPassphrase: string },
  expected: UnsignedIntent,
): void {
  const samePassphrase = wallet.networkPassphrase === expected.networkPassphrase;
  const sameNetwork = wallet.network.toUpperCase() === expected.network;
  if (!samePassphrase || !sameNetwork) {
    throw new ProtocolError("NETWORK_MISMATCH");
  }
}

/**
 * Runs the full CHW signing flow: fetch unsigned intent, verify the wallet is
 * on the expected network, sign, then submit through the server preflight.
 */
export async function signVerificationIntent(
  requestId: string,
  walletId: WalletId,
  deps: WalletSigningDeps,
): Promise<SignedIntent> {
  const kit = await deps.loadWalletKit();
  await kit.setWallet(walletId);

  const intent = await deps.fetchUnsignedIntent(requestId);

  const walletNetwork = await kit.getNetwork();
  assertWalletNetwork(walletNetwork, intent);

  const address = await kit.getPublicKey();
  const { signedTxXdr } = await kit.signTransaction(intent.xdr, {
    networkPassphrase: intent.networkPassphrase,
    address,
  });

  return deps.submitSignedIntent(requestId, signedTxXdr);
}
