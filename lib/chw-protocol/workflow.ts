import "server-only";

import { ProtocolError, type TrustState } from "./types";

export type VerificationRequestStatus =
  | "pending" | "leased" | "submitted" | "confirming" | "completed" | "failed" | "expired";

/** Public, non-clinical projection used by CHW and patient clients. */
export type VerificationStatus = "requested" | "processing" | "verified" | "failed";

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
