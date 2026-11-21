/**
 * Incident lifecycle helpers (issue #944).
 *
 * Pure functions only: severity matrix, timeline rendering and the postmortem
 * draft. The CLI (`lib/ops/cli.ts`) wires these to the database and to the
 * GitHub issue API. No PHI or capability tokens are ever read or emitted here;
 * timeline entries are operator-facing metadata (deploys, flag changes, alerts,
 * audit-log commands).
 */

export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export interface SeverityRow {
  severity: Severity;
  patientSafety: string;
  dataExposure: string;
  response: string;
  regulatorNotification: string;
}

/**
 * Severity matrix tied to patient safety and data exposure. The highest
 * matching row wins; `classifySeverity` encodes that ordering.
 */
export const SEVERITY_MATRIX: SeverityRow[] = [
  {
    severity: "SEV1",
    patientSafety: "Confirmed or suspected harm to a patient",
    dataExposure: "PHI or capability tokens exposed to an unauthorised party",
    response: "Page on-call immediately; incident commander + comms lead",
    regulatorNotification:
      "Notify NDPC and affected data subjects within 72h (NDPA s.40)",
  },
  {
    severity: "SEV2",
    patientSafety: "Emergency card or attestation unavailable to clinicians",
    dataExposure: "Suspected exposure, or exposure limited to non-PHI metadata",
    response: "Page on-call; status page update within 30 minutes",
    regulatorNotification:
      "Assess NDPA s.40 breach test; record decision in postmortem",
  },
  {
    severity: "SEV3",
    patientSafety: "Degraded but safe fallback path available",
    dataExposure: "No exposure; internal-only data affected",
    response: "Business hours response; fix within one working day",
    regulatorNotification: "No notification expected; record rationale",
  },
  {
    severity: "SEV4",
    patientSafety: "No patient-facing impact",
    dataExposure: "No exposure",
    response: "Track as normal work",
    regulatorNotification: "Not applicable",
  },
];

const SEVERITY_ORDER: Severity[] = ["SEV1", "SEV2", "SEV3", "SEV4"];

export function isSeverity(value: string): value is Severity {
  return (SEVERITY_ORDER as string[]).includes(value);
}

/** Returns the most severe row matching the declared impact flags. */
export function classifySeverity(input: {
  patientHarm: boolean;
  cardUnavailable: boolean;
  dataExposure: boolean;
}): Severity {
  if (input.patientHarm || input.dataExposure) return "SEV1";
  if (input.cardUnavailable) return "SEV2";
  return "SEV3";
}

/** Severity from the `--severity` flag, or derived from the impact flags. */
export function resolveSeverity(flags: Record<string, string>): Severity {
  if (flags.severity && isSeverity(flags.severity)) return flags.severity;
  return classifySeverity({
    patientHarm: flags["patient-harm"] === "true",
    cardUnavailable: flags["card-unavailable"] === "true",
    dataExposure: flags["data-exposure"] === "true",
  });
}

export interface TimelineEntry {
  at: string;
  source: "deploy" | "flag" | "alert" | "audit" | "operator";
  summary: string;
}

/** Chronological Markdown table of the incident timeline. */
export function renderTimeline(entries: TimelineEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const lines = [
    "| Time (UTC) | Source | Event |",
    "|---|---|---|",
    ...sorted.map(
      (e) => `| ${e.at} | ${e.source} | ${e.summary.replace(/\|/g, "\\|")} |`,
    ),
  ];
  return lines.join("\n");
}

export interface PostmortemInput {
  id: string;
  title: string;
  severity: Severity;
  declaredAt: string;
  issueUrl?: string;
  timeline: TimelineEntry[];
}

/** Markdown postmortem draft, including the regulator-notification checklist. */
export function renderPostmortem(input: PostmortemInput): string {
  const row =
    SEVERITY_MATRIX.find((r) => r.severity === input.severity) ??
    SEVERITY_MATRIX[SEVERITY_MATRIX.length - 1];
  return [
    `# Postmortem: ${input.title}`,
    "",
    `- Incident: \`${input.id}\``,
    `- Severity: **${input.severity}**`,
    `- Declared: ${input.declaredAt}`,
    ...(input.issueUrl ? [`- Tracking issue: ${input.issueUrl}`] : []),
    "",
    "## Severity rationale",
    "",
    "| Dimension | Assessment |",
    "|---|---|",
    `| Patient safety | ${row.patientSafety} |`,
    `| Data exposure | ${row.dataExposure} |`,
    `| Response | ${row.response} |`,
    "",
    "## Timeline",
    "",
    renderTimeline(input.timeline),
    "",
    "## Impact",
    "",
    "_Patients affected, records exposed, duration._",
    "",
    "## Root cause",
    "",
    "_Five whys; link the failing deploy or flag change from the timeline._",
    "",
    "## Detection",
    "",
    "_Which alert fired, and how long after the first bad change?_",
    "",
    "## Regulator notification checklist",
    "",
    "- [ ] Confirm whether PHI or capability tokens were exposed",
    "- [ ] Apply the NDPA s.40 breach test and record the decision",
    "- [ ] If notifiable: notify NDPC within 72 hours of awareness",
    "- [ ] If notifiable: notify affected data subjects without undue delay",
    "- [ ] Record notification reference numbers in this document",
    "- [ ] Update `compliance/` evidence with the decision and timestamps",
    "",
    "## Action items",
    "",
    "| Action | Owner | Due | Issue |",
    "|---|---|---|---|",
    "| | | | |",
    "",
  ].join("\n");
}
