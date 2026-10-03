import { NextResponse } from "next/server";

import { checkAndIncrementFrequency } from "@/lib/frequency-limit";
import { logWarn } from "@/lib/logging/logger";
import { getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Issue #520: CSP violation reports are unauthenticated, browser-triggered,
// fire-and-forget POSTs -- a hostile page (or a script probing this origin)
// could otherwise spam this endpoint. Kept small since a legitimate report
// is a few hundred bytes; both limits below are generous multiples of that.
const MAX_BODY_BYTES = 16 * 1024;
const CSP_REPORT_FREQUENCY_MAX = 20;
const CSP_REPORT_FREQUENCY_WINDOW_SECONDS = 60;

export interface NormalizedCspReport {
  directive: string;
  documentUrl: string | undefined;
  blockedUrl: string | undefined;
  disposition: string | undefined;
}

/**
 * Card URLs are bearer capabilities (see app/(public)/card/[id]/page.tsx and
 * .../card/c/[token]/page.tsx) -- the token/id segment must never be
 * persisted or forwarded anywhere, including in a "document-uri" or
 * "blocked-uri" a browser includes in a CSP report. Strips the query string
 * too, since a capability can just as easily travel there.
 *
 * Returns the input unchanged if it isn't a parseable absolute URL --
 * browsers also use non-URL values here (e.g. "inline", "eval", "data",
 * "self"), which carry nothing sensitive to redact.
 */
export function redactReportUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(
    /^\/card\/c\/[^/]+/,
    "/card/c/[redacted]",
  );
  url.pathname = url.pathname.replace(/^\/card\/(?!c\/)[^/]+/, "/card/[redacted]");
  return `${url.origin}${url.pathname}`;
}

/** Host only -- never the full blocked-resource path, which may itself carry a capability. */
export function blockedOriginOf(rawUrl: string | undefined): string {
  if (!rawUrl) return "unknown";
  try {
    return new URL(rawUrl).host;
  } catch {
    // Non-URL blocked-uri values (e.g. "inline", "eval", "data:") -- these
    // are directive-classification values already, not sensitive.
    return rawUrl;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** application/csp-report (CSP Level 2 -- still the most widely emitted format). */
function normalizeLegacyReport(body: unknown): NormalizedCspReport[] {
  const outer = asRecord(body);
  const report = outer ? asRecord(outer["csp-report"]) : null;
  if (!report) return [];
  return [
    {
      directive:
        asString(report["effective-directive"]) ??
        asString(report["violated-directive"]) ??
        "unknown",
      documentUrl: asString(report["document-uri"]),
      blockedUrl: asString(report["blocked-uri"]),
      disposition: asString(report["disposition"]),
    },
  ];
}

/** application/reports+json (Reporting API v1 -- an array of report objects). */
function normalizeReportingApiEntries(body: unknown): NormalizedCspReport[] {
  if (!Array.isArray(body)) return [];
  const reports: NormalizedCspReport[] = [];
  for (const entry of body) {
    const e = asRecord(entry);
    if (!e || e.type !== "csp-violation") continue;
    const b = asRecord(e.body);
    if (!b) continue;
    reports.push({
      directive: asString(b.effectiveDirective) ?? "unknown",
      documentUrl: asString(b.documentURL) ?? asString(e.url),
      blockedUrl: asString(b.blockedURL),
      disposition: asString(b.disposition),
    });
  }
  return reports;
}

function tooLarge() {
  return new NextResponse(null, { status: 413 });
}

export async function POST(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return tooLarge();
  }

  const ip = await getClientIp();
  const frequency = await checkAndIncrementFrequency(
    `csp-report:${ip}`,
    CSP_REPORT_FREQUENCY_MAX,
    CSP_REPORT_FREQUENCY_WINDOW_SECONDS,
  );
  if (!frequency.allowed) {
    return NextResponse.json(
      { error: "Too many CSP reports." },
      {
        status: 429,
        headers: { "Retry-After": String(frequency.retryAfterSeconds) },
      },
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return tooLarge();
  }

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    // Malformed body from a browser we don't control -- nothing useful to
    // report back to it (it never reads the response anyway), so just
    // acknowledge and drop it rather than surfacing a 4xx for noise.
    return new NextResponse(null, { status: 204 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const reports = contentType.includes("application/reports+json")
    ? normalizeReportingApiEntries(parsed)
    : normalizeLegacyReport(parsed);

  for (const report of reports) {
    logWarn("csp_violation", {
      directive: report.directive,
      blockedOrigin: blockedOriginOf(report.blockedUrl),
      routeClass: redactReportUrl(report.documentUrl) ?? "unknown",
      disposition: report.disposition ?? "unknown",
    });
  }

  return new NextResponse(null, { status: 204 });
}
