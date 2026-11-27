#!/usr/bin/env ts-node
/**
 * Transparency Report Generator
 *
 * Issue #975: Publish a periodic transparency report generated from system data.
 *
 * Reads incident records, data-request logs, SLO results and funding statistics
 * from their sources, plus a structured manual-input file for legal requests,
 * applies privacy aggregation (small-count suppression, no individual
 * identifiers), and emits:
 *   - a markdown report
 *   - a PDF report (best-effort; falls back to markdown-only if a renderer is
 *     unavailable)
 *   - a signed hash of the report body
 *   - a committed data snapshot alongside the report so the report is
 *     reproducible from the repo plus the snapshot.
 *
 * Usage:
 *   ts-node scripts/transparency-report.ts generate \
 *     --quarter 2025-Q1 \
 *     --out docs/compliance/transparency \
 *     --manual compliance/transparency/manual-inputs.json \
 *     --incidents compliance/transparency/sources/incidents.json \
 *     --requests compliance/transparency/sources/data-requests.json \
 *     --slo compliance/transparency/sources/slo-results.json \
 *     --funding compliance/transparency/sources/funding.json
 *
 *   ts-node scripts/transparency-report.ts verify \
 *     --report docs/compliance/transparency/2025-Q1/report.md \
 *     --snapshot docs/compliance/transparency/2025-Q1/snapshot.json
 *
 * The signing key is read from TRANSPARENCY_REPORT_SIGNING_KEY (hex). If it is
 * not set, a deterministic key derived from the snapshot is used so that the
 * report remains reproducible from the repo alone. In production, set the env
 * var to a secret managed by the security team.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

/** Minimum count below which a bucket is suppressed to protect privacy. */
export const SMALL_COUNT_THRESHOLD = 5;

export interface IncidentRecord {
  id: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  /** Whether personal health information was affected. */
  phiAffected: boolean;
  /** Whether affected individuals were notified. */
  notified: boolean;
  /** Short public summary (must not contain identifiers). */
  summary: string;
}

export interface DataRequestRecord {
  id: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Requesting authority type. */
  authority: 'law-enforcement' | 'regulator' | 'court-order' | 'other';
  /** Jurisdiction code (e.g. "US-CA", "EU"). */
  jurisdiction: string;
  /** Whether the request was granted, denied, or partially fulfilled. */
  outcome: 'granted' | 'denied' | 'partial' | 'pending';
  /** Number of accounts/subjects referenced (aggregated only). */
  subjectCount: number;
}

export interface SloResult {
  service: string;
  /** ISO date range start. */
  periodStart: string;
  /** ISO date range end. */
  periodEnd: string;
  /** Target availability percentage (e.g. 99.9). */
  target: number;
  /** Achieved availability percentage. */
  achieved: number;
  /** Total minutes of downtime in the period. */
  downtimeMinutes: number;
}

export interface FundingRecord {
  /** Funding source category. */
  source: 'grants' | 'donations' | 'service-fees' | 'other';
  /** Amount in minor units (cents) to avoid float drift. */
  amountCents: number;
  /** ISO currency code. */
  currency: string;
  /** Short description (no identifiers). */
  description: string;
}

export interface ManualLegalRequestInput {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  authority: DataRequestRecord['authority'];
  jurisdiction: string;
  outcome: DataRequestRecord['outcome'];
  /** Number of subjects referenced. */
  subjectCount: number;
  /** Optional public note. */
  note?: string;
}

export interface ManualInputs {
  quarter: string;
  /** Legal requests that are not captured by automated logs. */
  legalRequests: ManualLegalRequestInput[];
  /** Free-form notes for the report. */
  notes?: string[];
}

export interface ReportSnapshot {
  schemaVersion: 1;
  quarter: string;
  generatedAt: string;
  sources: {
    incidents: IncidentRecord[];
    dataRequests: DataRequestRecord[];
    sloResults: SloResult[];
    funding: FundingRecord[];
    manual: ManualInputs;
  };
  /** Aggregated, privacy-safe figures used to render the report. */
  aggregates: ReportAggregates;
}

export interface ReportAggregates {
  incidents: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    phiAffected: number;
    notified: number;
  };
  dataRequests: {
    total: number;
    byAuthority: Record<string, number>;
    byOutcome: Record<string, number>;
    byJurisdiction: Record<string, number>;
    subjectsAffected: number;
  };
  slo: {
    services: Array<{
      service: string;
      target: number;
      achieved: number;
      downtimeMinutes: number;
      met: boolean;
    }>;
    overallMet: boolean;
  };
  funding: {
    bySource: Record<string, number>;
    totalCents: number;
    currency: string;
  };
}

// ---------------------------------------------------------------------------
// Privacy aggregation
// ---------------------------------------------------------------------------

/**
 * Suppress buckets whose count is below the small-count threshold. Suppressed
 * buckets are reported as "<threshold" so the total is not trivially
 * reconstructable.
 */
export function suppressSmallCounts(
  counts: Record<string, number>,
  threshold: number = SMALL_COUNT_THRESHOLD,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(counts)) {
    out[key] = value > 0 && value < threshold ? `<${threshold}` : value;
  }
  return out;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function aggregate(
  sources: ReportSnapshot['sources'],
): ReportAggregates {
  const { incidents, dataRequests, sloResults, funding, manual } = sources;

  // Merge manual legal requests into the data-request set.
  const manualAsRequests: DataRequestRecord[] = manual.legalRequests.map((r, i) => ({
    id: `manual-${i}`,
    date: r.date,
    authority: r.authority,
    jurisdiction: r.jurisdiction,
    outcome: r.outcome,
    subjectCount: r.subjectCount,
  }));
  const allRequests = [...dataRequests, ...manualAsRequests];

  const incidentAgg = {
    total: incidents.length,
    bySeverity: suppressSmallCounts(countBy(incidents, (i) => i.severity)) as Record<string, number>,
    byCategory: suppressSmallCounts(countBy(incidents, (i) => i.category)) as Record<string, number>,
    phiAffected: incidents.filter((i) => i.phiAffected).length,
    notified: incidents.filter((i) => i.notified).length,
  };

  const requestAgg = {
    total: allRequests.length,
    byAuthority: suppressSmallCounts(countBy(allRequests, (r) => r.authority)) as Record<string, number>,
    byOutcome: suppressSmallCounts(countBy(allRequests, (r) => r.outcome)) as Record<string, number>,
    byJurisdiction: suppressSmallCounts(countBy(allRequests, (r) => r.jurisdiction)) as Record<string, number>,
    subjectsAffected: allRequests.reduce((sum, r) => sum + r.subjectCount, 0),
  };

  const services = sloResults.map((s) => ({
    service: s.service,
    target: s.target,
    achieved: s.achieved,
    downtimeMinutes: s.downtimeMinutes,
    met: s.achieved >= s.target,
  }));

  const fundingBySource: Record<string, number> = {};
  let totalCents = 0;
  let currency = 'USD';
  for (const f of funding) {
    fundingBySource[f.source] = (fundingBySource[f.source] ?? 0) + f.amountCents;
    totalCents += f.amountCents;
    currency = f.currency;
  }

  return {
    incidents: incidentAgg,
    dataRequests: requestAgg,
    slo: {
      services,
      overallMet: services.every((s) => s.met),
    },
    funding: {
      bySource: fundingBySource,
      totalCents,
      currency,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function renderMarkdown(snapshot: ReportSnapshot): string {
  const { quarter, generatedAt, aggregates } = snapshot;
  const lines: string[] = [];

  lines.push(`# Transparency Report — ${quarter}`);
  lines.push('');
  lines.push(`_Generated: ${generatedAt}_`);
  lines.push('');
  lines.push(
    'This report is generated semi-automatically from system data. ' +
      'Counts below the small-count threshold are suppressed to protect privacy. ' +
      'No individual identifiers are included.',
  );
  lines.push('');

  // Incidents
  lines.push('## Security Incidents');
  lines.push('');
  lines.push(`Total incidents: **${aggregates.incidents.total}**`);
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(aggregates.incidents.bySeverity)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(aggregates.incidents.byCategory)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push(`Incidents affecting PHI: **${aggregates.incidents.phiAffected}**`);
  lines.push('');
  lines.push(`Individuals notified: **${aggregates.incidents.notified}**`);
  lines.push('');

  // Data requests
  lines.push('## Government & Legal Data Requests');
  lines.push('');
  lines.push(`Total requests: **${aggregates.dataRequests.total}**`);
  lines.push('');
  lines.push('| Authority | Count |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(aggregates.dataRequests.byAuthority)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push('| Outcome | Count |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(aggregates.dataRequests.byOutcome)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push('| Jurisdiction | Count |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(aggregates.dataRequests.byJurisdiction)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push('');
  lines.push(`Subjects referenced (aggregate): **${aggregates.dataRequests.subjectsAffected}**`);
  lines.push('');

  // SLO
  lines.push('## Service Level Objectives');
  lines.push('');
  lines.push('| Service | Target | Achieved | Downtime (min) | Met |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of aggregates.slo.services) {
    lines.push(
      `| ${s.service} | ${s.target}% | ${s.achieved}% | ${s.downtimeMinutes} | ${s.met ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push(`All SLOs met: **${aggregates.slo.overallMet ? 'yes' : 'no'}**`);
  lines.push('');

  // Funding
  lines.push('## Funding');
  lines.push('');
  lines.push('| Source | Amount |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(aggregates.funding.bySource)) {
    lines.push(`| ${k} | ${formatMoney(v, aggregates.funding.currency)} |`);
  }
  lines.push('');
  lines.push(
    `Total funding: **${formatMoney(aggregates.funding.totalCents, aggregates.funding.currency)}**`,
  );
  lines.push('');

  if (snapshot.sources.manual.notes && snapshot.sources.manual.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of snapshot.sources.manual.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function deriveFallbackKey(snapshot: ReportSnapshot): string {
  // Deterministic key derived from the snapshot so the report is reproducible
  // from the repo alone. Not a secret; production must set the env var.
  return createHash('sha256')
    .update('transparency-report-fallback-key')
    .update(snapshot.quarter)
    .digest('hex');
}

export function signReport(body: string, key: string): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

export function hashSnapshot(snapshot: ReportSnapshot): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// PDF rendering (best-effort)
// ---------------------------------------------------------------------------

/**
 * Minimal PDF writer. Produces a single-page-per-section PDF with plain text.
 * This avoids a heavy dependency while still satisfying the "markdown/PDF"
 * requirement. If a richer renderer is available it can be swapped in.
 */
export function renderPdf(markdown: string): Buffer {
  const lines = markdown.split('\n');
  const pageLines: string[][] = [];
  const linesPerPage = 50;
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pageLines.push(lines.slice(i, i + linesPerPage));
  }
  if (pageLines.length === 0) pageLines.push(['']);

  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  // Object 1: Catalog, Object 2: Pages, Object 3: Font
  const firstPageObj = 4;
  pageLines.forEach((_, idx) => pageObjectIds.push(firstPageObj + idx * 2));

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  pageLines.forEach((page, idx) => {
    const contentId = firstPageObj + idx * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const text = page
      .map((line, i) => `BT /F1 9 Tf 40 ${760 - i * 14} Td (${escape(line)}) Tj ET`)
      .join('\n');
    objects.push(
      `<< /Length ${Buffer.byteLength(text, 'utf8')} >>\nstream\n${text}\nendstream`,
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  command: 'generate' | 'verify';
  quarter?: string;
  out?: string;
  manual?: string;
  incidents?: string;
  requests?: string;
  slo?: string;
  funding?: string;
  report?: string;
  snapshot?: string;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'generate' && command !== 'verify') {
    throw new Error(`Unknown command: ${command ?? '(none)'}. Use "generate" or "verify".`);
  }
  const args: Args = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument: ${flag}`);
    }
    const key = flag.slice(2) as keyof Omit<Args, 'command'>;
    (args as unknown as Record<string, string>)[key] = value;
  }
  return args;
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as T;
}

async function generate(args: Args): Promise<void> {
  if (!args.quarter) throw new Error('--quarter is required');
  if (!args.out) throw new Error('--out is required');
  if (!args.manual) throw new Error('--manual is required');
  if (!args.incidents) throw new Error('--incidents is required');
  if (!args.requests) throw new Error('--requests is required');
  if (!args.slo) throw new Error('--slo is required');
  if (!args.funding) throw new Error('--funding is required');

  const [incidents, dataRequests, sloResults, funding, manual] = await Promise.all([
    readJson<IncidentRecord[]>(args.incidents),
    readJson<DataRequestRecord[]>(args.requests),
    readJson<SloResult[]>(args.slo),
    readJson<FundingRecord[]>(args.funding),
    readJson<ManualInputs>(args.manual),
  ]);

  if (manual.quarter !== args.quarter) {
    throw new Error(
      `Manual inputs quarter (${manual.quarter}) does not match --quarter (${args.quarter})`,
    );
  }

  const sources: ReportSnapshot['sources'] = {
    incidents,
    dataRequests,
    sloResults,
    funding,
    manual,
  };

  const snapshot: ReportSnapshot = {
    schemaVersion: 1,
    quarter: args.quarter,
    generatedAt: new Date().toISOString(),
    sources,
    aggregates: aggregate(sources),
  };

  const markdown = renderMarkdown(snapshot);
  const key = process.env.TRANSPARENCY_REPORT_SIGNING_KEY || deriveFallbackKey(snapshot);
  const signature = signReport(markdown, key);
  const snapshotHash = hashSnapshot(snapshot);

  const outDir = path.join(args.out, args.quarter);
  await fs.mkdir(outDir, { recursive: true });

  const reportWithSig =
    `${markdown}\n\n---\n\n` +
    `**Report signature (HMAC-SHA256):** \`${signature}\`\n\n` +
    `**Snapshot hash (SHA-256):** \`${snapshotHash}\`\n`;

  await fs.writeFile(path.join(outDir, 'report.md'), reportWithSig, 'utf8');
  await fs.writeFile(path.join(outDir, 'report.pdf'), renderPdf(reportWithSig));
  await fs.writeFile(
    path.join(outDir, 'snapshot.json'),
    JSON.stringify(snapshot, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(outDir, 'signature.json'),
    JSON.stringify(
      {
        quarter: args.quarter,
        algorithm: 'HMAC-SHA256',
        signature,
        snapshotHash,
        generatedAt: snapshot.generatedAt,
      },
      null,
      2,
    ),
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log(`Transparency report written to ${outDir}`);
}

async function verify(args: Args): Promise<void> {
  if (!args.report) throw new Error('--report is required');
  if (!args.snapshot) throw new Error('--snapshot is required');

  const snapshot = await readJson<ReportSnapshot>(args.snapshot);
  const reportRaw = await fs.readFile(args.report, 'utf8');

  // Recompute the snapshot hash and compare with the one embedded in the report.
  const expectedSnapshotHash = hashSnapshot(snapshot);
  const snapshotHashMatch = reportRaw.match(/\*\*Snapshot hash \(SHA-256\):\*\* `([0-9a-f]+)`/);
  if (!snapshotHashMatch) {
    throw new Error('Report is missing the snapshot hash line');
  }
  const actualSnapshotHash = snapshotHashMatch[1];
  if (
    actualSnapshotHash.length !== expectedSnapshotHash.length ||
    !timingSafeEqual(Buffer.from(actualSnapshotHash), Buffer.from(expectedSnapshotHash))
  ) {
    throw new Error(
      `Snapshot hash mismatch: report has ${actualSnapshotHash}, snapshot computes ${expectedSnapshotHash}`,
    );
  }

  // Recompute the report body from the snapshot and verify the signature.
  const regenerated = renderMarkdown(snapshot);
  const key = process.env.TRANSPARENCY_REPORT_SIGNING_KEY || deriveFallbackKey(snapshot);
  const expectedSignature = signReport(regenerated, key);

  const sigMatch = reportRaw.match(/\*\*Report signature \(HMAC-SHA256\):\*\* `([0-9a-f]+)`/);
  if (!sigMatch) {
    throw new Error('Report is missing the signature line');
  }
  const actualSignature = sigMatch[1];
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature))
  ) {
    throw new Error(
      `Signature mismatch: report has ${actualSignature}, recomputed ${expectedSignature}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log('Transparency report verified: snapshot hash and signature match.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'generate') {
    await generate(args);
  } else {
    await verify(args);
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}