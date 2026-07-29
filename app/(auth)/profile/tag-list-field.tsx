"use client";

import { useState } from "react";

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

  return (
    <div>
      <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </span>
      <div className="mt-1 flex flex-col gap-2">
        {values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <input
              name={name}
              type="text"
              value={value}
              placeholder={placeholder}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                setValues(next);
              }}
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? `${name}-error` : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <button
              type="button"
              onClick={() => setValues(values.filter((_, i) => i !== index))}
              disabled={values.length === 1}
              aria-label={`Remove ${label.toLowerCase()} entry`}
              className="rounded-md border border-zinc-300 px-3 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setValues([...values, ""])}
        className="mt-2 text-sm font-medium text-zinc-950 underline dark:text-zinc-50"
      >
        + Add {label.toLowerCase()}
      </button>
      {error ? (
        <p id={`${name}-error`} className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
