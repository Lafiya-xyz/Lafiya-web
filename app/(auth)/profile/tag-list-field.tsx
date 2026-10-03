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
 * Severity of an allergic reaction, ordered from least to most severe.
 * Mirrors the severity enum in lib/validation/profile.ts.
 */
export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe"] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

/**
 * Clinical criticality of an allergy, ordered from least to most urgent.
 * Mirrors the criticality enum in lib/validation/profile.ts.
 */
export const ALLERGY_CRITICALITIES = [
  "low",
  "high",
  "unable-to-assess",
] as const;
export type AllergyCriticality = (typeof ALLERGY_CRITICALITIES)[number];

/**
 * A structured allergy entry: a coded substance (with a free-text fallback),
 * the reaction type, severity, and criticality. Serialized to a single hidden
 * input as JSON so the server action can read the full list back via
 * `formData.getAll(name)`.
 */
export type AllergyEntry = {
  substance_text: string;
  coded: string | null;
  reaction: string;
  severity: AllergySeverity;
  criticality: AllergyCriticality;
};

/**
 * Parses the JSON-serialized allergy entries submitted by the form. Returns an
 * empty list when the field is absent or malformed so the server action can
 * surface its own validation error rather than crashing here.
 */
export function parseAllergyEntries(raw: string | null): AllergyEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AllergyEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * A dynamic, add/remove list of plain-text values (medications, chronic
 * conditions). Renders one input per item, all sharing `name`, so the server
 * action can read the full list back via `formData.getAll(name)`.
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
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {values.length} / {MAX_ITEMS}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {values.map((value, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
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
              className="min-w-0 flex-1 basis-40 rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
            <button
              type="button"
              onClick={() => setValues(values.filter((_, i) => i !== index))}
              disabled={values.length === 1}
              aria-label={`Remove ${label.toLowerCase()} entry`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-zinc-300 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
            >
              &times;
            </button>
            {isDuplicateTag(values, index) ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">
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

/**
 * A structured allergy editor: each entry captures a substance (free-text with
 * an optional coded value), reaction type, severity, and criticality. Entries
 * are serialized to a single hidden input as JSON so the server action can
 * read the full list back via `formData.getAll(name)`. Existing free-text tags
 * are migrated losslessly into `{substance_text, coded: null}` entries.
 */
export function AllergyListField({
  name,
  label,
  placeholder,
  initialValues,
  error,
}: {
  name: string;
  label: string;
  placeholder?: string;
  initialValues: AllergyEntry[];
  error?: string;
}) {
  const [entries, setEntries] = useState<AllergyEntry[]>(
    initialValues.length > 0
      ? initialValues
      : [
          {
            substance_text: "",
            coded: null,
            reaction: "",
            severity: "mild",
            criticality: "low",
          },
        ],
  );
  const [limitMessage, setLimitMessage] = useState<string | null>(null);

  function updateEntry(index: number, patch: Partial<AllergyEntry>) {
    setEntries((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  }

  function handleAdd() {
    if (entries.length >= MAX_ITEMS) {
      setLimitMessage(
        `You've reached the limit of ${MAX_ITEMS} ${label.toLowerCase()}.`,
      );
      return;
    }
    setLimitMessage(null);
    setEntries([
      ...entries,
      {
        substance_text: "",
        coded: null,
        reaction: "",
        severity: "mild",
        criticality: "low",
      },
    ]);
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {entries.length} / {MAX_ITEMS}
        </span>
      </div>
      <input type="hidden" name={name} value={JSON.stringify(entries)} />
      <div className="mt-1 flex flex-col gap-3">
        {entries.map((entry, index) => (
          <fieldset
            key={index}
            className="rounded-md border border-zinc-300 p-3 dark:border-zinc-700"
          >
            <legend className="px-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {label} {index + 1}
            </legend>
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <label htmlFor={`${name}-substance-${index}`} className="sr-only">
                  Substance {index + 1}
                </label>
                <input
                  id={`${name}-substance-${index}`}
                  type="text"
                  value={entry.substance_text}
                  placeholder={placeholder}
                  maxLength={MAX_TAG_LENGTH}
                  onChange={(event) =>
                    updateEntry(index, { substance_text: event.target.value })
                  }
                  onBlur={(event) =>
                    updateEntry(index, {
                      substance_text: normalizeTagValue(event.target.value),
                    })
                  }
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? `${name}-error` : undefined}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
                />
                <button
                  type="button"
                  onClick={() =>
                    setEntries(entries.filter((_, i) => i !== index))
                  }
                  disabled={entries.length === 1}
                  aria-label={`Remove ${label.toLowerCase()} entry`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-zinc-300 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
                >
                  &times;
                </button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="flex-1">
                  <label
                    htmlFor={`${name}-reaction-${index}`}
                    className="block text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    Reaction
                  </label>
                  <input
                    id={`${name}-reaction-${index}`}
                    type="text"
                    value={entry.reaction}
                    placeholder="e.g. anaphylaxis"
                    maxLength={MAX_TAG_LENGTH}
                    onChange={(event) =>
                      updateEntry(index, { reaction: event.target.value })
                    }
                    className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`${name}-severity-${index}`}
                    className="block text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    Severity
                  </label>
                  <select
                    id={`${name}-severity-${index}`}
                    value={entry.severity}
                    onChange={(event) =>
                      updateEntry(index, {
                        severity: event.target.value as AllergySeverity,
                      })
                    }
                    className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
                  >
                    {ALLERGY_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor={`${name}-criticality-${index}`}
                    className="block text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    Criticality
                  </label>
                  <select
                    id={`${name}-criticality-${index}`}
                    value={entry.criticality}
                    onChange={(event) =>
                      updateEntry(index, {
                        criticality: event.target.value as AllergyCriticality,
                      })
                    }
                    className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
                  >
                    {ALLERGY_CRITICALITIES.map((criticality) => (
                      <option key={criticality} value={criticality}>
                        {criticality}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </fieldset>
        ))}
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Up to {MAX_ITEMS} entries, {MAX_TAG_LENGTH} characters each.
      </p>
      <button
        type="button"
        onClick={handleAdd}
        disabled={entries.length >= MAX_ITEMS}
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
