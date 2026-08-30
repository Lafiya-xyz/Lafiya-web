'use client';

import { useState } from 'react';

import type { ConsentHistoryEntry } from './consent/actions';

const PAGE_SIZE = 5;

function formatAcceptedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function ConsentHistoryList({
  history,
}: {
  history: ConsentHistoryEntry[];
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visible = history.slice(0, visibleCount);
  const hasMore = visibleCount < history.length;

  return (
    <>
      <ul className="flex flex-col gap-1 text-sm">
        {visible.map((entry) => (
          <li
            key={entry.policyVersion}
            className="flex items-center justify-between"
          >
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              {entry.policyVersion}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              accepted {formatAcceptedAt(entry.acceptedAt)}
            </span>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          className="mt-1 text-sm font-medium text-zinc-950 underline dark:text-zinc-50"
        >
          Show more
        </button>
      )}
    </>
  );
}
