'use client';

import { useId } from 'react';

/**
 * A single data point for an accessible chart.
 * `label` is the human-readable category (e.g. a region or period).
 * `value` is the numeric aggregate (e.g. verified cards funded).
 */
export interface AccessibleChartDatum {
  label: string;
  value: number;
}

export interface AccessibleChartProps {
  /** Chart title, rendered as a heading and used as the accessible name. */
  title: string;
  /** Optional short description of what the chart shows. */
  description?: string;
  /** Ordered data points to visualize. */
  data: AccessibleChartDatum[];
  /** Formats a numeric value for display (axis, tooltip, and table). */
  formatValue?: (value: number) => string;
  /** Accessible label for the underlying data table. */
  tableCaption?: string;
}

const defaultFormatValue = (value: number): string =>
  new Intl.NumberFormat('en-US').format(value);

/**
 * Accessible bar chart with a text alternative.
 *
 * The visual bars are decorative (`aria-hidden`) and every figure is also
 * exposed through a real `<table>` so screen readers and axe checks get a
 * complete, non-visual representation of the data. No PHI is rendered here;
 * callers are expected to pass already-suppressed aggregates.
 */
export default function AccessibleChart({
  title,
  description,
  data,
  formatValue = defaultFormatValue,
  tableCaption,
}: AccessibleChartProps) {
  const headingId = useId();
  const tableId = useId();

  const max = data.reduce((acc, datum) => Math.max(acc, datum.value), 0);
  const total = data.reduce((acc, datum) => acc + datum.value, 0);

  return (
    <figure
      className="flex flex-col gap-4"
      aria-labelledby={headingId}
      role="group"
    >
      <figcaption className="flex flex-col gap-1">
        <h3 id={headingId} className="text-base font-semibold">
          {title}
        </h3>
        {description ? (
          <p className="text-sm text-gray-600">{description}</p>
        ) : null}
      </figcaption>

      {data.length === 0 ? (
        <p className="text-sm text-gray-600">
          No data available for this period.
        </p>
      ) : (
        <>
          <ul
            className="flex flex-col gap-2"
            aria-hidden="true"
            data-testid="accessible-chart-bars"
          >
            {data.map((datum) => {
              const width = max > 0 ? (datum.value / max) * 100 : 0;
              return (
                <li key={datum.label} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate text-sm text-gray-700">
                    {datum.label}
                  </span>
                  <span className="h-4 flex-1 rounded bg-gray-100">
                    <span
                      className="block h-4 rounded bg-blue-600"
                      style={{ width: `${width}%` }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums text-gray-900">
                    {formatValue(datum.value)}
                  </span>
                </li>
              );
            })}
          </ul>

          <table
            id={tableId}
            className="w-full border-collapse text-sm"
            data-testid="accessible-chart-table"
          >
            <caption className="sr-only">
              {tableCaption ?? `Data table for ${title}`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="border-b border-gray-200 py-2 text-left">
                  Category
                </th>
                <th scope="col" className="border-b border-gray-200 py-2 text-right">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((datum) => (
                <tr key={datum.label}>
                  <th scope="row" className="py-2 text-left font-normal text-gray-700">
                    {datum.label}
                  </th>
                  <td className="py-2 text-right tabular-nums text-gray-900">
                    {formatValue(datum.value)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="border-t border-gray-200 py-2 text-left">
                  Total
                </th>
                <td className="border-t border-gray-200 py-2 text-right tabular-nums text-gray-900">
                  {formatValue(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </figure>
  );
}
