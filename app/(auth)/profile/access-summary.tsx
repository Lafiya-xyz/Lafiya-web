import { formatDateTime } from "@/lib/format/datetime";

export function AccessSummary({
  viewsLast30Days,
  lastViewedAt,
}: {
  viewsLast30Days: number;
  lastViewedAt: string | null;
}) {
  return (
    <section
      aria-labelledby="access-summary-heading"
      className="rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"
    >
      <h2 id="access-summary-heading" className="font-semibold">
        Card access summary
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {viewsLast30Days === 0
          ? "No successful card views were recorded in the last 30 days."
          : `${viewsLast30Days} successful card view${viewsLast30Days === 1 ? "" : "s"} recorded in the last 30 days.`}
      </p>
      {lastViewedAt ? (
        <p className="mt-2 text-xs text-zinc-500">
          Most recent successful view: {formatDateTime(lastViewedAt)}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-zinc-500">
        This is a privacy-preserving aggregate. Lafiya does not store an IP
        address, user agent, or the raw QR capability for card access.
      </p>
    </section>
  );
}
