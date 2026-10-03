"use client";

import { useActionState } from "react";
import { useEffect, useRef, useState } from "react";

import { BLOOD_GROUPS, GENOTYPES } from "@/lib/validation/profile";
import type { ProfileRow } from "@/lib/supabase/types";

import { upsertProfile } from "./actions";
import { CriticalFieldsBanner } from "./critical-fields-banner";
import { EmergencyContactsField } from "./emergency-contacts-field";
import { PhotoUploadField } from "./photo-upload-field";
import { TagListField } from "./tag-list-field";

const DRAFT_DB_NAME = "handsoff-profile-drafts";
const DRAFT_STORE = "drafts";
const DRAFT_KEY_ALG = { name: "AES-GCM", length: 256 } as const;

function draftKey(userId: string) {
  return `profile-draft:${userId}`;
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getDraftKey(userId: string): Promise<CryptoKey> {
  const db = await openDraftDb();
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readonly");
    const req = tx.objectStore(DRAFT_STORE).get(draftKey(userId));
    req.onsuccess = () => resolve(req.result?.key as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(DRAFT_KEY_ALG, false, [
    "encrypt",
    "decrypt",
  ]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).put({ key }, draftKey(userId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

async function saveDraft(userId: string, values: Record<string, string>) {
  const key = await getDraftKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(values));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const db = await openDraftDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).put(
      { iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) },
      draftKey(userId),
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDraft(userId: string): Promise<Record<string, string> | null> {
  const db = await openDraftDb();
  const record = await new Promise<{ iv: number[]; cipher: number[] } | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, "readonly");
      const req = tx.objectStore(DRAFT_STORE).get(draftKey(userId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    },
  );
  if (!record?.cipher) return null;
  const key = await getDraftKey(userId);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(record.iv) },
      key,
      new Uint8Array(record.cipher),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

async function clearDraft(userId: string) {
  const db = await openDraftDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).delete(draftKey(userId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function ProfileForm({
  profile,
  userId,
  signedPhotoUrl,
}: {
  profile: ProfileRow | null;
  userId: string;
  /**
   * Issue #528: short-lived signed URL for the initial avatar preview,
   * resolved server-side by the profile page. Null when no photo or
   * signing failed. Passed to PhotoUploadField as initialUrl.
   */
  signedPhotoUrl?: string | null;
}) {
  const [state, formAction, isPending] = useActionState(
    upsertProfile,
    undefined,
  );

  const [isDirtyState, setIsDirtyState] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [conflict, setConflict] = useState<Record<string, string> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // isDirty is true when the form has been changed AND the last action did not succeed
  const isDirty = isDirtyState && !state?.success;

  // Warn on tab close / page reload when there are unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty]);

  // Restore any encrypted draft persisted for this user on mount.
  useEffect(() => {
    let cancelled = false;
    loadDraft(userId).then((draft) => {
      if (cancelled || !draft || !formRef.current) return;
      for (const [name, value] of Object.entries(draft)) {
        const field = formRef.current.elements.namedItem(name);
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLSelectElement ||
          field instanceof HTMLTextAreaElement
        ) {
          field.value = value;
        }
      }
      setIsDirtyState(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Track connectivity and replay queued drafts when back online.
  useEffect(() => {
    const update = () => setIsOffline(!navigator.onLine);
    update();
    const handleOnline = () => {
      setIsOffline(false);
      formRef.current?.requestSubmit();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Clear drafts once a save succeeds.
  useEffect(() => {
    if (state?.success) {
      clearDraft(userId).catch(() => {});
      setConflict(null);
    }
  }, [state?.success, userId]);

  // Surface revision conflicts as a field-level merge prompt.
  useEffect(() => {
    if (
      state?.error?.includes(
        "This profile was updated elsewhere since you loaded this page",
      )
    ) {
      loadDraft(userId).then((draft) => {
        if (draft) setConflict(draft);
      });
    }
  }, [state?.error, userId]);

  const handleChange = () => {
    setIsDirtyState(true);
    if (!formRef.current) return;
    const values: Record<string, string> = {};
    const data = new FormData(formRef.current);
    for (const [name, value] of data.entries()) {
      if (typeof value === "string") values[name] = value;
    }
    saveDraft(userId, values).catch(() => {});
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    if (isOffline) {
      event.preventDefault();
      handleChange();
    }
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      onChange={handleChange}
      onSubmit={handleSubmit}
      data-dirty={isDirty ? "true" : undefined}
      className="flex flex-col gap-6"
    >
      {profile ? (
        <input
          type="hidden"
          name="expectedRevisionId"
          value={profile.current_revision_id ?? ""}
        />
      ) : null}

      {isOffline ? (
        <p
          role="status"
          data-testid="profile-offline-status"
          className="text-sm text-amber-600 dark:text-amber-400"
        >
          You are offline. Your edits are saved on this device and will sync
          when you reconnect.
        </p>
      ) : null}

      {state?.error &&
      !state.error.includes(
        "This profile was updated elsewhere since you loaded this page",
      ) ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state?.success ? (
        <p
          role="status"
          data-testid="profile-save-status"
          className="text-sm text-emerald-600 dark:text-emerald-400"
        >
          Saved.
        </p>
      ) : null}

      {state?.error?.includes(
        "This profile was updated elsewhere since you loaded this page",
      ) ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">Conflict detected</p>
          <p className="mt-1">
            This profile was updated elsewhere since you loaded this page.
            Review your draft against the current values before saving.
          </p>
          {conflict ? (
            <ul className="mt-2 list-disc pl-5">
              {Object.entries(conflict).map(([field, value]) => (
                <li key={field}>
                  <span className="font-medium">{field}</span>: {value}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Fields marked with{" "}
        <span aria-hidden="true" className="text-red-600 dark:text-red-400">
          *
        </span>
        <span className="sr-only"> (required)</span> are required. Everything
        else is optional but helps make the emergency card more useful.
      </p>

      <CriticalFieldsBanner
        bloodGroupMissing={
          !profile?.blood_group || profile.blood_group === "unknown"
        }
        allergiesMissing={!profile?.allergies || profile.allergies.length === 0}
      />

      <PhotoUploadField
        userId={userId}
        initialUrl={signedPhotoUrl ?? null}
        error={state?.errors?.photoUrl}
      />

      <div>
        <label
          htmlFor="name"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Full name{" "}
          <span aria-hidden="true" className="text-red-600 dark:text-red-400">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={profile?.name ?? ""}
          aria-invalid={state?.errors?.name ? "true" : undefined}
          aria-describedby={state?.errors?.name ? "name-error" : undefined}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
        {state?.errors?.name ? (
          <p
            id="name-error"
            className="mt-1 text-sm text-red-600 dark:text-red-400"
          >
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
          aria-describedby={
            state?.errors?.dateOfBirth ? "dateOfBirth-error" : undefined
          }
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
        {state?.errors?.dateOfBirth ? (
          <p
            id="dateOfBirth-error"
            className="mt-1 text-sm text-red-600 dark:text-red-400"
          >
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
          aria-describedby={
            state?.errors?.language ? "language-error" : undefined
          }
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
        {state?.errors?.language ? (
          <p
            id="language-error"
            className="mt-1 text-sm text-red-600 dark:text-red-400"
          >
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
            aria-describedby={
              state?.errors?.bloodGroup ? "bloodGroup-error" : undefined
            }
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
          >
            {BLOOD_GROUPS.map((value) => (
              <option key={value} value={value}>
                {value === "unknown" ? "Unknown" : value}
              </option>
            ))}
          </select>
          {state?.errors?.bloodGroup ? (
            <p
              id="bloodGroup-error"
              className="mt-1 text-sm text-red-600 dark:text-red-400"
            >
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
            aria-describedby={
              state?.errors?.genotype ? "genotype-error" : undefined
            }
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
          >
            {GENOTYPES.map((value) => (
              <option key={value} value={value}>
                {value === "unknown" ? "Unknown" : value}
              </option>
            ))}
          </select>
          {state?.errors?.genotype ? (
            <p
              id="genotype-error"
              className="mt-1 text-sm text-red-600 dark:text-red-400"
            >
              {state.errors.genotype}
            </p>
          ) : null}
        </div>
      </div>

      <TagListField
        name="allergies"
        label="Allergies"
        initialValues={profile?.allergies ?? []}
        error={state?.errors?.allergies}
      />

      <TagListField
        name="conditions"
        label="Medical conditions"
        initialValues={profile?.conditions ?? []}
        error={state?.errors?.conditions}
      />

      <EmergencyContactsField
        initialContacts={profile?.emergency_contacts ?? []}
        error={state?.errors?.emergencyContacts}
      />

      <button
        type="submit"
        disabled={isPending}
        className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {isPending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
