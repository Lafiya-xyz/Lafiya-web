import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type RemittanceSchedule,
  remittanceScheduleCsv,
} from "./withholding";

/**
 * Signed remittance artefacts (issue #910).
 *
 * The PDF is a minimal, dependency-free PDF 1.4 document (same approach as
 * lib/pdf/accessible-card.ts) carrying the schedule totals and a detached
 * HMAC-SHA256 signature over the canonical CSV body. The signature is printed
 * in the document and returned separately so a tax authority can verify the
 * PDF against the CSV they were sent.
 */

export const REMITTANCE_SIGNATURE_HEADER = "X-Lafiya-Remittance-Signature";

export type SignedRemittance = {
  csv: string;
  pdf: Buffer;
  signature: string;
  filename: string;
};

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function pdfText(lines: readonly string[]): Buffer {
  const content = [
    "BT",
    "/F1 11 Tf",
    "14 TL",
    "50 780 Td",
    ...lines.map((line) => `(${escapePdfText(line)}) Tj T*`),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** HMAC-SHA256 over the CSV body, hex encoded. */
export function signRemittanceCsv(csv: string, secret: string): string {
  return createHmac("sha256", secret).update(csv, "utf8").digest("hex");
}

export function verifyRemittanceSignature(
  csv: string,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signRemittanceCsv(csv, secret), "hex");
  const provided = Buffer.from(signature, "hex");
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

function usdc(micro: number): string {
  return (micro / 1_000_000).toFixed(7);
}

/** Renders the schedule as a signed PDF + CSV pair. */
export function renderSignedRemittance(
  schedule: RemittanceSchedule,
  secret: string,
): SignedRemittance {
  const csv = remittanceScheduleCsv(schedule);
  const signature = signRemittanceCsv(csv, secret);
  const lines = [
    "Lafiya CHW payout withholding remittance",
    `Period: ${schedule.period}`,
    `Jurisdiction: ${schedule.jurisdiction}`,
    `Payouts: ${schedule.lines.length}`,
    `Gross (USDC): ${usdc(schedule.grossMicro)}`,
    `Withheld (USDC): ${usdc(schedule.withheldMicro)}`,
    `Net paid (USDC): ${usdc(schedule.netMicro)}`,
    "",
    "Signature (HMAC-SHA256 over the accompanying CSV):",
    signature,
  ];
  return {
    csv,
    pdf: pdfText(lines),
    signature,
    filename: `remittance-${schedule.jurisdiction}-${schedule.period}`,
  };
}
