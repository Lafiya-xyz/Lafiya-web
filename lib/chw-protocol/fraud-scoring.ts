/**
 * CHW fraud scoring: rule definitions and pure scoring functions.
 *
 * Implements the "flag suspicious CHWs" issue. The heavy aggregation
 * (burst velocity, shared device/IP, near-duplicate, mutual graph) runs in
 * SQL materialized views (see
 * supabase/migrations/20260928120000_chw_fraud_scoring.sql,
 * `evaluate_fraud_rules()`), which is the source of truth in production.
 * This module holds:
 *  - typed mirrors of the rule catalog so callers get compile-time safety
 *    when referencing rule codes,
 *  - pure, side-effect-free scoring functions used by the synthetic-fixture
 *    tests to validate rule logic independent of a live database, and
 *  - the reviewer-action audit helper used by the admin release/void flow.
 *
 * Privacy: signals operate on device_id/ip_address/timestamps/revision_id
 * only -- never on patient health record content. No PHI is read, logged,
 * or persisted by this module.
 */

export type FraudRuleCode =
  | "burst_velocity_v1"
  | "shared_device_ip_v1"
  | "near_duplicate_v1"
  | "mutual_graph_v1";

export interface FraudRuleDefinition {
  ruleCode: FraudRuleCode;
  signalFamily: "burst_velocity" | "shared_device_ip" | "near_duplicate" | "mutual_graph";
  shadowMode: boolean;
}

export const DEFAULT_FRAUD_RULES: FraudRuleDefinition[] = [
  { ruleCode: "burst_velocity_v1", signalFamily: "burst_velocity", shadowMode: true },
  { ruleCode: "shared_device_ip_v1", signalFamily: "shared_device_ip", shadowMode: true },
  { ruleCode: "near_duplicate_v1", signalFamily: "near_duplicate", shadowMode: true },
  { ruleCode: "mutual_graph_v1", signalFamily: "mutual_graph", shadowMode: true },
];

export interface VerificationIntentSignal {
  chwId: string;
  intentId: string;
  revisionId: string;
  deviceId?: string;
  ipAddress?: string;
  issuedAt: Date;
}

export interface FraudFinding {
  chwId: string;
  ruleCode: FraudRuleCode;
  reasonCode: string;
  evidence: Record<string, unknown>;
  severityScore: number;
}

/** Mirrors mv_chw_verification_velocity + the burst_velocity_v1 threshold check. */
export function detectBurstVelocity(
  intents: VerificationIntentSignal[],
  maxPerHour: number,
): FraudFinding[] {
  const buckets = new Map<string, VerificationIntentSignal[]>();
  for (const intent of intents) {
    const hourBucket = new Date(intent.issuedAt);
    hourBucket.setMinutes(0, 0, 0);
    const key = `${intent.chwId}:${hourBucket.toISOString()}`;
    const list = buckets.get(key) ?? [];
    list.push(intent);
    buckets.set(key, list);
  }

  const findings: FraudFinding[] = [];
  for (const [key, list] of buckets) {
    if (list.length > maxPerHour) {
      findings.push({
        chwId: list[0].chwId,
        ruleCode: "burst_velocity_v1",
        reasonCode: "burst_velocity_exceeded",
        evidence: { bucketKey: key, intentsInHour: list.length },
        severityScore: list.length,
      });
    }
  }
  return findings;
}

/** Mirrors mv_shared_device_ip_clusters + shared_device_ip_v1 threshold check. */
export function detectSharedDeviceOrIp(
  intents: VerificationIntentSignal[],
  minDistinctChws: number,
): FraudFinding[] {
  const clusters = new Map<string, Set<string>>();
  for (const intent of intents) {
    const key = intent.deviceId ?? intent.ipAddress;
    if (!key) continue;
    const set = clusters.get(key) ?? new Set<string>();
    set.add(intent.chwId);
    clusters.set(key, set);
  }

  const findings: FraudFinding[] = [];
  for (const [clusterKey, chwIds] of clusters) {
    if (chwIds.size >= minDistinctChws) {
      for (const chwId of chwIds) {
        findings.push({
          chwId,
          ruleCode: "shared_device_ip_v1",
          reasonCode: "shared_device_or_ip",
          evidence: { clusterKey, distinctChwCount: chwIds.size },
          severityScore: chwIds.size,
        });
      }
    }
  }
  return findings;
}

/** Mirrors mv_near_duplicate_intents + near_duplicate_v1 window check. */
export function detectNearDuplicates(
  intents: VerificationIntentSignal[],
  windowMinutes: number,
): FraudFinding[] {
  const byChwAndRevision = new Map<string, VerificationIntentSignal[]>();
  for (const intent of intents) {
    const key = `${intent.chwId}:${intent.revisionId}`;
    const list = byChwAndRevision.get(key) ?? [];
    list.push(intent);
    byChwAndRevision.set(key, list);
  }

  const findings: FraudFinding[] = [];
  for (const list of byChwAndRevision.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const secondsApart = (sorted[i].issuedAt.getTime() - sorted[i - 1].issuedAt.getTime()) / 1000;
      if (secondsApart < windowMinutes * 60) {
        findings.push({
          chwId: sorted[i].chwId,
          ruleCode: "near_duplicate_v1",
          reasonCode: "near_duplicate_resubmission",
          evidence: {
            intentId: sorted[i].intentId,
            duplicateOfIntentId: sorted[i - 1].intentId,
            secondsApart,
          },
          severityScore: 1,
        });
      }
    }
  }
  return findings;
}

/** Reviewer action audit record for the release/void workflow (app/api/admin/quarantine). */
export interface ReviewerAction {
  flagId: string;
  action: "release" | "void";
  reviewerId: string;
  note?: string;
  actedAt: Date;
}

export function buildReviewerAuditEntry(
  flagId: string,
  action: ReviewerAction["action"],
  reviewerId: string,
  note?: string,
): ReviewerAction {
  return { flagId, action, reviewerId, note, actedAt: new Date() };
}
