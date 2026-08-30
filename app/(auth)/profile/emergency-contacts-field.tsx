"use client";

import { useState } from "react";

import type { EmergencyContact } from "@/lib/supabase/types";

const MAX_CONTACTS = 3;
const EMPTY_CONTACT: EmergencyContact = {
  name: "",
  phone: "",
  relationship: "",
};

/**
 * Up to 3 emergency contacts. Submitted as a single JSON hidden input
 * (rather than indexed field names) so the server action can read the
 * whole structured list back with one formData.get() + JSON.parse.
 */
export function EmergencyContactsField({
  initialValues,
  error,
}: {
  initialValues: EmergencyContact[];
  error?: string;
}) {
  const [contacts, setContacts] = useState(
    initialValues.length > 0 ? initialValues : [EMPTY_CONTACT],
  );
  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);

  function updateContact(
    index: number,
    field: keyof EmergencyContact,
    value: string,
  ) {
    const next = contacts.map((contact, i) =>
      i === index ? { ...contact, [field]: value } : contact,
    );
    setContacts(next);
  }

  function handleRemoveAll() {
    setContacts([EMPTY_CONTACT]);
    setConfirmingRemoveAll(false);
  }

  return (
    <div>
      <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Emergency contacts
      </span>
      <input
        type="hidden"
        name="emergencyContactsJson"
        value={JSON.stringify(contacts)}
        readOnly
      />
      <div className="mt-1 flex flex-col gap-3">
        {contacts.map((contact, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-md border border-zinc-300 p-3 sm:flex-row dark:border-zinc-700"
          >
            <input
              type="text"
              placeholder="Name"
              value={contact.name}
              onChange={(event) =>
                updateContact(index, "name", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <input
              type="tel"
              placeholder="Phone (e.g. +2348012345678)"
              value={contact.phone}
              onChange={(event) =>
                updateContact(index, "phone", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <input
              type="text"
              placeholder="Relationship"
              value={contact.relationship}
              onChange={(event) =>
                updateContact(index, "relationship", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <button
              type="button"
              onClick={() =>
                setContacts(contacts.filter((_, i) => i !== index))
              }
              disabled={contacts.length === 1}
              aria-label="Remove emergency contact"
              className="shrink-0 rounded-md border border-zinc-300 px-3 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setContacts([...contacts, EMPTY_CONTACT])}
          disabled={contacts.length >= MAX_CONTACTS}
          className="text-sm font-medium text-zinc-950 underline disabled:opacity-40 dark:text-zinc-50"
        >
          + Add contact
        </button>
        {contacts.length >= 2 && !confirmingRemoveAll && (
          <button
            type="button"
            onClick={() => setConfirmingRemoveAll(true)}
            className="text-sm font-medium text-red-600 underline dark:text-red-400"
          >
            Remove all
          </button>
        )}
      </div>
      {confirmingRemoveAll && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/40">
          <p className="text-sm text-red-800 dark:text-red-200">
            Are you sure? This will remove all contacts.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRemoveAll}
              className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
            >
              Yes, remove all
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRemoveAll(false)}
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error ? (
        <p id="emergencyContacts-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
