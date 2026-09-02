"use client";

import type { ProfileRow } from "@/lib/supabase/types";

const RECOMMENDED_FIELDS: Array<{
  key: keyof ProfileRow;
  label: string;
  isEmergencyCritical: boolean;
}> = [
  { key: "name", label: "Full name", isEmergencyCritical: true },
  { key: "blood_group", label: "Blood group", isEmergencyCritical: true },
  { key: "allergies", label: "Allergies", isEmergencyCritical: true },
  { key: "medications", label: "Current medications", isEmergencyCritical: true },
  { key: "emergency_contacts", label: "Emergency contacts", isEmergencyCritical: true },
  { key: "genotype", label: "Genotype", isEmergencyCritical: false },
  { key: "chronic_conditions", label: "Chronic conditions", isEmergencyCritical: false },
  { key: "language", label: "Language spoken", isEmergencyCritical: false },
  { key: "date_of_birth", label: "Date of birth", isEmergencyCritical: false },
];

export function ProfileCompleteness({ profile }: { profile: ProfileRow }) {
  const filled = RECOMMENDED_FIELDS.filter((field) => {
    const value = profile[field.key];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return value !== null && value !== undefined;
  }).length;

  const total = RECOMMENDED_FIELDS.length;
  const emergencyCriticalFilled = RECOMMENDED_FIELDS.filter(
    (field) => {
      if (!field.isEmergencyCritical) return false;
      const value = profile[field.key];
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "string") return value.trim().length > 0;
      return value !== null && value !== undefined;
    }
  ).length;

  return (
    <div className="rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Profile completeness
      </h3>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {filled} of {total} recommended fields filled
        {emergencyCriticalFilled < 5 && (
          <span className="ml-2 text-amber-600 dark:text-amber-400">
            ({emergencyCriticalFilled}/5 emergency-critical fields)
          </span>
        )}
      </p>
      <div className="mt-2 h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className="h-2 rounded-full bg-zinc-900 transition-all dark:bg-white"
          style={{ width: `${(filled / total) * 100}%` }}
        />
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {RECOMMENDED_FIELDS.map((field) => {
          const value = profile[field.key];
          const isFilled = Array.isArray(value)
            ? value.length > 0
            : typeof value === "string"
              ? value.trim().length > 0
              : value !== null && value !== undefined;
          return (
            <li
              key={field.key}
              className={`rounded-full px-2 py-1 text-xs ${
                isFilled
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {field.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
