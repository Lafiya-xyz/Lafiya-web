import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Spike PoC — zero-knowledge membership proof of "verified by an allowlisted
 * attester" without revealing which attester (issue #904; see
 * docs/attester-allowlist-zk-spike.md).
 *
 * The construction is a *keyed* membership proof over the on-chain attester
 * allowlist, not a general-purpose zk-SNARK:
 *
 *  1. The allowlist authority derives a per-attester tag
 *     `tag = HMAC-SHA256(allowlistKey, attesterAddress)` and publishes the
 *     sorted tag set (the "commitment") alongside the allowlist root.
 *  2. An attester proves membership by revealing `tag` and a binding that only
 *     the holder of that tag could produce, without revealing the address
 *     itself. The responder checks the tag is in the published set and that
 *     the binding covers the record hash and its own freshness nonce.
 *  3. The proof is bound to a record hash and a freshness nonce, so it cannot
 *     be replayed onto another record or reused after the allowlist rotates.
 *
 * What this hides: the attester's Stellar address (and therefore their
 * identity, payout history and caseload) from responders and from anyone
 * reading the attestation payload.
 *
 * What this does NOT hide, and must be stated in the report: the tag is a
 * deterministic pseudonym, so two attestations by the same attester are
 * linkable unless the tag is re-randomized per epoch. The allowlist authority
 * (key holder) can de-anonymize any tag, and because the binding is keyed by
 * the tag, anyone who learns a tag can forge proofs for it — so the tag must
 * never be published. This is a deliberate trade-off for a dependency-free
 * PoC; the report compares it against a Groth16/Noir circuit over a Merkle
 * allowlist, which removes both weaknesses at the cost of a trusted setup and
 * a proving dependency.
 *
 * Import-safe: no `serverEnv`, no Supabase, no network I/O. The allowlist key
 * is passed in by the caller.
 */

/** Domain separation so tags cannot be confused with other HMAC uses. */
const TAG_DOMAIN = "lafiya-attester-allowlist-tag:v1";
const PROOF_DOMAIN = "lafiya-attester-membership-proof:v1";

/** Tags are 32 bytes; hex-encoded they are 64 chars. */
export const ALLOWLIST_TAG_BYTES = 32;

export type AllowlistTag = string;

export type AllowlistCommitment = {
  /** Sorted, de-duplicated hex tags of every allowlisted attester. */
  tags: AllowlistTag[];
  /** SHA-256 over the sorted tag list — the value published on-chain. */
  root: string;
  /** Monotonic epoch; bumping it invalidates proofs bound to older epochs. */
  epoch: number;
};

export type MembershipProof = {
  /** The attester's pseudonymous tag (revealed). */
  tag: AllowlistTag;
  /** Commitment root the proof was made against. */
  root: string;
  /** Allowlist epoch the proof was made against. */
  epoch: number;
  /** Hex record hash the proof is bound to. */
  recordHash: string;
  /** Caller-supplied freshness nonce (single-use, server-issued). */
  nonce: string;
  /** HMAC over the binding fields, keyed by the attester's tag. */
  binding: string;
};

export type MembershipVerification =
  | { ok: true; tag: AllowlistTag; epoch: number }
  | {
      ok: false;
      reason:
        | "malformed_proof"
        | "unknown_root"
        | "stale_epoch"
        | "tag_not_allowlisted"
        | "record_mismatch"
        | "invalid_binding";
    };

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `allowlist-membership: ${field} must be a non-empty string`,
    );
  }
}

function assertHex(value: string, field: string): void {
  assertNonEmpty(value, field);
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`allowlist-membership: ${field} is not valid hex`);
  }
}

/** Derive the pseudonymous tag for one attester address. */
export function deriveAttesterTag(
  allowlistKey: string,
  attesterAddress: string,
): AllowlistTag {
  assertNonEmpty(allowlistKey, "allowlistKey");
  assertNonEmpty(attesterAddress, "attesterAddress");
  return createHmac("sha256", allowlistKey)
    .update(`${TAG_DOMAIN}:${attesterAddress}`)
    .digest("hex");
}

/**
 * Build the published commitment for an allowlist snapshot. Tags are sorted so
 * the root is order-independent and reproducible by any verifier.
 */
export function buildAllowlistCommitment(
  allowlistKey: string,
  attesterAddresses: readonly string[],
  epoch: number,
): AllowlistCommitment {
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(
      "allowlist-membership: epoch must be a non-negative integer",
    );
  }
  const tags = Array.from(
    new Set(
      attesterAddresses.map((address) => deriveAttesterTag(allowlistKey, address)),
    ),
  ).sort();
  return { tags, root: rootFor(tags), epoch };
}

function rootFor(sortedTags: readonly string[]): string {
  return createHash("sha256").update(sortedTags.join(",")).digest("hex");
}

function bindingFor(
  tag: AllowlistTag,
  root: string,
  epoch: number,
  recordHash: string,
  nonce: string,
): string {
  return createHmac("sha256", tag)
    .update(`${PROOF_DOMAIN}:${root}:${epoch}:${recordHash}:${nonce}`)
    .digest("hex");
}

/**
 * Produce a membership proof for one attester. The attester address is used
 * only to derive the tag and is never included in the returned proof.
 */
export function proveAllowlistMembership(params: {
  allowlistKey: string;
  attesterAddress: string;
  commitment: AllowlistCommitment;
  recordHash: string;
  nonce: string;
}): MembershipProof {
  const { allowlistKey, attesterAddress, commitment, recordHash, nonce } =
    params;
  assertHex(recordHash, "recordHash");
  assertNonEmpty(nonce, "nonce");
  const tag = deriveAttesterTag(allowlistKey, attesterAddress);
  if (!commitment.tags.includes(tag)) {
    throw new Error(
      "allowlist-membership: attester is not in the supplied allowlist commitment",
    );
  }
  return {
    tag,
    root: commitment.root,
    epoch: commitment.epoch,
    recordHash,
    nonce,
    binding: bindingFor(tag, commitment.root, commitment.epoch, recordHash, nonce),
  };
}

/**
 * Verify a proof against the commitment the responder trusts. The responder
 * never learns the attester address; it learns only "some allowlisted
 * attester, at epoch N, attested this record hash".
 *
 * `expectedRecordHash` and `expectedNonce` are supplied by the responder (the
 * nonce is the one it issued), which is what makes the proof non-replayable.
 */
export function verifyAllowlistMembership(
  proof: MembershipProof,
  commitment: AllowlistCommitment,
  expected: { recordHash: string; nonce: string },
): MembershipVerification {
  if (
    !proof ||
    typeof proof.tag !== "string" ||
    typeof proof.root !== "string" ||
    typeof proof.epoch !== "number" ||
    typeof proof.recordHash !== "string" ||
    typeof proof.nonce !== "string" ||
    typeof proof.binding !== "string" ||
    proof.tag.length !== ALLOWLIST_TAG_BYTES * 2 ||
    !/^[0-9a-f]+$/.test(proof.tag) ||
    !/^[0-9a-f]+$/.test(proof.binding)
  ) {
    return { ok: false, reason: "malformed_proof" };
  }
  if (proof.root !== commitment.root) {
    return { ok: false, reason: "unknown_root" };
  }
  if (rootFor(commitment.tags) !== commitment.root) {
    return { ok: false, reason: "unknown_root" };
  }
  if (proof.epoch !== commitment.epoch) {
    return { ok: false, reason: "stale_epoch" };
  }
  if (!commitment.tags.includes(proof.tag)) {
    return { ok: false, reason: "tag_not_allowlisted" };
  }
  if (proof.recordHash !== expected.recordHash) {
    return { ok: false, reason: "record_mismatch" };
  }
  if (proof.nonce !== expected.nonce) {
    return { ok: false, reason: "invalid_binding" };
  }
  const expectedBinding = Buffer.from(
    bindingFor(proof.tag, proof.root, proof.epoch, proof.recordHash, proof.nonce),
  );
  const actualBinding = Buffer.from(proof.binding);
  if (
    expectedBinding.length !== actualBinding.length ||
    !timingSafeEqual(expectedBinding, actualBinding)
  ) {
    return { ok: false, reason: "invalid_binding" };
  }
  return { ok: true, tag: proof.tag, epoch: proof.epoch };
}

/**
 * Responder-facing projection: the only attester information that may be
 * surfaced on a public card or in a responder payload. Deliberately excludes
 * the tag, which is a stable pseudonym and would allow cross-record linkage.
 */
export function publicAttesterClaim(
  verification: MembershipVerification,
): { verifiedByAllowlistedAttester: boolean; allowlistEpoch: number | null } {
  return verification.ok
    ? { verifiedByAllowlistedAttester: true, allowlistEpoch: verification.epoch }
    : { verifiedByAllowlistedAttester: false, allowlistEpoch: null };
}
