"use client";

import { useActionState } from "react";

import { BLOOD_GROUPS, GENOTYPES } from "@/lib/validation/profile";
import type { ProfileRow } from "@/lib/supabase/types";

import { upsertProfile } from "./actions";
import { EmergencyContactsField } from "./emergency-contacts-field";
import { PhotoUploadField } from "./photo-upload-field";
import { TagListField } from "./tag-list-field";

export function ProfileForm({
  profile,
  userId,
}: {
  profile: ProfileRow | null;
  userId: string;
}) {
  const [state, formAction, isPending] = useActionState(
    upsertProfile,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {profile ? (
        <input
          type="hidden"
          name="expectedUpdatedAt"
          value={profile.updated_at}
        />
      ) : null}

      {state?.error && !state.error.includes("This profile was updated elsewhere since you loaded this page") ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}
      {state?.success ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
      ) : null}

      {state?.error?.includes("This profile was updated elsewhere since you loaded this page") ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">Conflict detected</p>
          <p className="mt-1">This profile was updated elsewhere since you loaded this page. Reload and reapply your changes before saving.</p>
        </div>
      ) : null}

      <PhotoUploadField
        userId={userId}
        initialUrl={profile?.photo_url ?? null}
        error={state?.errors?.photoUrl}
      />

      <div>
        <label
          htmlFor="name"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Full name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={profile?.name ?? ""}
          aria-invalid={state?.errors?.name ? "true" : undefined}
          aria-describedby={state?.errors?.name ? "name-error" : undefined}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
        {state?.errors?.name ? (
          <p id="name-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
            {state.errors.name}
          </p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor="dateOfBirth"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Date of birth
        </label>
        <input
          id="dateOfBirth"
          name="dateOfBirth"
          type="date"
          defaultValue={profile?.date_of_birth ?? ""}
          aria-invalid={state?.errors?.dateOfBirth ? "true" : undefined}
          aria-describedby={state?.errors?.dateOfBirth ? "dateOfBirth-error" : undefined}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
        {state?.errors?.dateOfBirth ? (
          <p id="dateOfBirth-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
            {state.errors.dateOfBirth}
          </p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor="language"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Language spoken
        </label>
        <input
          id="language"
          name="language"
          type="text"
          placeholder="e.g. Hausa"
          defaultValue={profile?.language ?? ""}
          aria-invalid={state?.errors?.language ? "true" : undefined}
          aria-describedby={state?.errors?.language ? "language-error" : undefined}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
        {state?.errors?.language ? (
          <p id="language-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
            {state.errors.language}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="bloodGroup"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Blood group
          </label>
          <select
            id="bloodGroup"
            name="bloodGroup"
            defaultValue={profile?.blood_group ?? "unknown"}
            aria-invalid={state?.errors?.bloodGroup ? "true" : undefined}
            aria-describedby={state?.errors?.bloodGroup ? "bloodGroup-error" : undefined}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          >
            {BLOOD_GROUPS.map((value) => (
              <option key={value} value={value}>
                {value === "unknown" ? "Unknown" : value}
              </option>
            ))}
          </select>
          {state?.errors?.bloodGroup ? (
            <p id="bloodGroup-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
              {state.errors.bloodGroup}
            </p>
          ) : null}
        </div>

        <div>
          <label
            htmlFor="genotype"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Genotype
          </label>
          <select
            id="genotype"
            name="genotype"
            defaultValue={profile?.genotype ?? "unknown"}
            aria-invalid={state?.errors?.genotype ? "true" : undefined}
            aria-describedby={state?.errors?.genotype ? "genotype-error" : undefined}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          >
            {GENOTYPES.map((value) => (
              <option key={value} value={value}>
                {value === "unknown" ? "Unknown" : value}
              </option>
            ))}
          </select>
          {state?.errors?.genotype ? (
            <p id="genotype-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
              {state.errors.genotype}
            </p>
          ) : null}
        </div>
      </div>

      <TagListField
        name="allergies"
        label="Allergies"
        placeholder="e.g. Penicillin"
        initialValues={profile?.allergies ?? []}
        error={state?.errors?.allergies}
      />

      <TagListField
        name="medications"
        label="Current medications"
        placeholder="e.g. Insulin"
        initialValues={profile?.medications ?? []}
        error={state?.errors?.medications}
      />

      <TagListField
        name="chronicConditions"
        label="Chronic conditions / implants"
        placeholder="e.g. Asthma"
        initialValues={profile?.chronic_conditions ?? []}
        error={state?.errors?.chronicConditions}
      />

      <EmergencyContactsField
        initialValues={profile?.emergency_contacts ?? []}
        error={state?.errors?.emergencyContacts}
      />

      <button
        type="submit"
        disabled={isPending}
        className="flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
