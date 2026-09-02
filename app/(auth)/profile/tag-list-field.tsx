"use client";

import { useState } from "react";

// Mirrors the .max(20) / .max(200) bounds in lib/validation/profile.ts.
const MAX_ITEMS = 20;
const MAX_TAG_LENGTH = 200;

/**
 * Trims a raw tag input so entries like " Penicillin " are stored and
 * compared identically to "Penicillin" — duplicate detection below only
 * works if values are normalized this way first.
 */
export function normalizeTagValue(value: string): string {
  return value.trim();
}

/**
 * True when the trimmed value at `index` case-sensitively matches another
 * trimmed, non-empty entry elsewhere in the list.
 */
export function isDuplicateTag(values: string[], index: number): boolean {
  const normalized = normalizeTagValue(values[index] ?? "");
  if (normalized === "") return false;
  return values.some(
    (other, otherIndex) =>
      otherIndex !== index && normalizeTagValue(other) === normalized,
  );
}

/**
 * A dynamic, add/remove list of plain-text values (allergies, medications,
 * chronic conditions). Renders one input per item, all sharing `name`, so
 * the server action can read the full list back via `formData.getAll(name)`.
 */
export function TagListField({
  name,
  label,
  placeholder,
  initialValues,
  error,
}: {
  name: string;
  label: string;
  placeholder?: string;
  initialValues: string[];
  error?: string;
}) {
  const [values, setValues] = useState(
    initialValues.length > 0 ? initialValues : [""],
  );
  const [limitMessage, setLimitMessage] = useState<string | null>(null);

  function handleAdd() {
    if (values.length >= MAX_ITEMS) {
      setLimitMessage(
        `You've reached the limit of ${MAX_ITEMS} ${label.toLowerCase()}.`,
      );
      return;
    }
    setLimitMessage(null);
    setValues([...values, ""]);
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {values.length} / {MAX_ITEMS}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <label htmlFor={`${name}-${index}`} className="sr-only">
              {label} {index + 1}
            </label>
            <input
              id={`${name}-${index}`}
              name={name}
              type="text"
              value={value}
              placeholder={placeholder}
              maxLength={MAX_TAG_LENGTH}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                setValues(next);
              }}
              onBlur={(event) => {
                const trimmed = normalizeTagValue(event.target.value);
                if (trimmed === values[index]) return;
                const next = [...values];
                next[index] = trimmed;
                setValues(next);
              }}
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? `${name}-error` : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
            <button
              type="button"
              onClick={() => setValues(values.filter((_, i) => i !== index))}
              disabled={values.length === 1}
              aria-label={`Remove ${label.toLowerCase()} entry`}
              className="rounded-md border border-zinc-300 px-3 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
            >
              &times;
            </button>
            {isDuplicateTag(values, index) ? (
              <span className="self-center text-xs text-amber-600 dark:text-amber-400">
                Duplicate
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Up to {MAX_ITEMS} entries, {MAX_TAG_LENGTH} characters each.
      </p>
      <button
        type="button"
        onClick={handleAdd}
        disabled={values.length >= MAX_ITEMS}
        className="mt-2 text-sm font-medium text-zinc-950 underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none rounded px-1 dark:text-zinc-50 dark:focus:ring-zinc-600"
      >
        + Add {label.toLowerCase()}
      </button>
      {limitMessage ? (
        <p role="alert" className="mt-1 text-sm text-amber-600 dark:text-amber-400">
          {limitMessage}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${name}-error`}
          className="mt-1 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
