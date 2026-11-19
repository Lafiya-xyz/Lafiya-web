import type { Metadata } from "next";
import Link from "next/link";
import fs from "node:fs";
import path from "node:path";

export const metadata: Metadata = {
  title: "Transparency Report | Health Data Platform",
  description:
    "Quarterly transparency report covering government data requests, security incidents, uptime, and funding flows. Reproducible from the public data snapshot and generator.",
};

type ReportEntry = {
  quarter: string;
  slug: string;
  publishedAt: string;
  hash: string;
  markdownPath: string;
  pdfPath?: string;
  snapshotPath: string;
  generatorPath: string;
  summary?: string;
};

const REPORTS_DIR = path.join(process.cwd(), "compliance", "transparency", "reports");
const INDEX_FILE = path.join(REPORTS_DIR, "index.json");

function loadReports(): ReportEntry[] {
  try {
    const raw = fs.readFileSync(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw) as { reports?: ReportEntry[] };
    const reports = Array.isArray(parsed.reports) ? parsed.reports : [];
    return reports
      .filter((r) => typeof r.quarter === "string" && typeof r.slug === "string")
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  } catch {
    return [];
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function shortHash(hash: string): string {
  if (hash.length <= 24) return hash;
  return `${hash.slice(0, 16)}…${hash.slice(-8)}`;
}

export default function TransparencyPage() {
  const reports = loadReports();
  const latest = reports[0];

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          Transparency Report
        </h1>
        <p className="mt-4 text-lg text-gray-700">
          Trust in a health-data platform depends on openness. We publish a
          quarterly transparency report covering government data requests,
          security incidents, uptime against our service-level objectives, and
          funding flows. Each report is generated from system data and can be
          reproduced from the public data snapshot and generator in this
          repository.
        </p>
      </header>

      <section aria-labelledby="latest-heading" className="mb-12">
        <h2
          id="latest-heading"
          className="text-2xl font-semibold text-gray-900"
        >
          Latest report
        </h2>

        {latest ? (
          <article className="mt-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-xl font-semibold text-gray-900">
                {latest.quarter} Transparency Report
              </h3>
              <p className="text-sm text-gray-600">
                Published{" "}
                <time dateTime={latest.publishedAt}>
                  {formatDate(latest.publishedAt)}
                </time>
              </p>
            </div>

            {latest.summary ? (
              <p className="mt-3 text-gray-700">{latest.summary}</p>
            ) : null}

            <dl className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  Signed hash (SHA-256)
                </dt>
                <dd className="mt-1 break-all font-mono text-sm text-gray-900">
                  <abbr title={latest.hash} aria-label="Full signed hash">
                    {shortHash(latest.hash)}
                  </abbr>
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500">
                  Report quarter
                </dt>
                <dd className="mt-1 text-sm text-gray-900">{latest.quarter}</dd>
              </div>
            </dl>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={latest.markdownPath}
                className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              >
                Read report (Markdown)
              </Link>
              {latest.pdfPath ? (
                <Link
                  href={latest.pdfPath}
                  className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  Download PDF
                </Link>
              ) : null}
            </div>

            <div className="mt-6 rounded-md bg-gray-50 p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Reproduce this report
              </h4>
              <p className="mt-1 text-sm text-gray-700">
                The report is reproducible from the repository and the data
                snapshot. Verify the signed hash against the generated output.
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                <li>
                  <Link
                    href={latest.snapshotPath}
                    className="text-blue-700 underline hover:text-blue-900"
                  >
                    Data snapshot
                  </Link>
                </li>
                <li>
                  <Link
                    href={latest.generatorPath}
                    className="text-blue-700 underline hover:text-blue-900"
                  >
                    Generator script
                  </Link>
                </li>
              </ul>
            </div>
          </article>
        ) : (
          <p className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4 text-gray-700">
            No transparency report has been published yet. Reports are generated
            quarterly from system data.
          </p>
        )}
      </section>

      <section aria-labelledby="privacy-heading" className="mb-12">
        <h2 id="privacy-heading" className="text-2xl font-semibold text-gray-900">
          Privacy protections
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 text-gray-700">
          <li>
            Legal requests are reported only in aggregate counts by category and
            outcome. Individual requests, requesters, and affected accounts are
            never disclosed.
          </li>
          <li>
            Security incidents are reported at the aggregate level (counts,
            severity, and remediation status). No personal health information
            (PHI) or individual incident details are included.
          </li>
          <li>
            Small-count suppression is applied so that aggregated figures cannot
            be used to re-identify individuals.
          </li>
          <li>
            Uptime and SLO results are reported as aggregate measurements against
            published objectives.
          </li>
        </ul>
      </section>

      <section aria-labelledby="previous-heading">
        <h2
          id="previous-heading"
          className="text-2xl font-semibold text-gray-900"
        >
          Previous quarters
        </h2>
        {reports.length > 1 ? (
          <ul className="mt-4 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
            {reports.slice(1).map((report) => (
              <li
                key={report.slug}
                className="flex flex-wrap items-center justify-between gap-2 p-4"
              >
                <div>
                  <Link
                    href={report.markdownPath}
                    className="font-medium text-blue-700 underline hover:text-blue-900"
                  >
                    {report.quarter} Transparency Report
                  </Link>
                  <p className="text-sm text-gray-600">
                    Published{" "}
                    <time dateTime={report.publishedAt}>
                      {formatDate(report.publishedAt)}
                    </time>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium text-gray-500">
                    Signed hash
                  </p>
                  <p className="break-all font-mono text-xs text-gray-900">
                    <abbr title={report.hash} aria-label="Full signed hash">
                      {shortHash(report.hash)}
                    </abbr>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-gray-700">
            No previous quarterly reports are available yet.
          </p>
        )}
      </section>
    </main>
  );
}