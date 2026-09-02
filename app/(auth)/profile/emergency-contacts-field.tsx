"use client";

import { useState } from "react";

import type { EmergencyContact } from "@/lib/supabase/types";
import { RELATIONSHIP_TYPES } from "@/lib/validation/profile";

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
 *
 * The limit is enforced both here (client-side, immediate feedback) and by
 * the server-side Zod schema in lib/validation/profile.ts, so a crafted
 * request that bypasses the UI cannot exceed the maximum either.
 */
export function EmergencyContactsField({
  initialValues,
  error,
}: {
  initialValues: EmergencyContact[];
  error?: string;
}) {
  const [contacts, setContacts] = useState(initialValues);
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const [relationshipFilter, setRelationshipFilter] = useState<Record<number, string>>({});
  const [confirmingRemoveAll, setConfirmingRemoveAll] = useState(false);

  const atLimit = contacts.length >= MAX_CONTACTS;

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

  function handleRelationshipChange(index: number, value: string) {
    updateContact(index, "relationship", value);
    setOpenDropdown(null);
    setRelationshipFilter((prev) => {
      const { [index]: _, ...rest } = prev;
      return rest;
    });
  }

  function getFilteredRelationships(index: number): typeof RELATIONSHIP_TYPES {
    const filter = relationshipFilter[index] || "";
    if (!filter) return RELATIONSHIP_TYPES;

    return RELATIONSHIP_TYPES.filter((rel) =>
      rel.toLowerCase().includes(filter.toLowerCase()),
    );
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
      {contacts.length === 0 ? (
        <div className="mt-1 flex flex-col items-start gap-3 rounded-md border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No emergency contacts added yet. Add someone we can reach if you
            have a medical emergency.
          </p>
          <button
            type="button"
            onClick={() => setContacts([EMPTY_CONTACT])}
            className="rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            + Add contact
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-col gap-3">
          {contacts.map((contact, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-md border border-zinc-300 p-3 sm:flex-row dark:border-zinc-700"
          >
            <label htmlFor={`contact-name-${index}`} className="sr-only">
              Emergency contact {index + 1} name
            </label>
            <input
              id={`contact-name-${index}`}
              type="text"
              placeholder="Name"
              value={contact.name}
              onChange={(event) =>
                updateContact(index, "name", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
            <label htmlFor={`contact-phone-${index}`} className="sr-only">
              Emergency contact {index + 1} phone
            </label>
            <input
              id={`contact-phone-${index}`}
              type="tel"
              placeholder="Phone (e.g. +2348012345678)"
              value={contact.phone}
              onChange={(event) =>
                updateContact(index, "phone", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
            <div className="relative w-full">
              <label
                htmlFor={`contact-relationship-${index}`}
                className="sr-only"
              >
                Emergency contact {index + 1} relationship
              </label>
              <input
                id={`contact-relationship-${index}`}
                type="text"
                placeholder="Relationship"
                value={
                  openDropdown === index
                    ? relationshipFilter[index] || ""
                    : contact.relationship
                }
                onChange={(event) => {
                  const value = event.target.value;
                  if (openDropdown !== index) {
                    setOpenDropdown(index);
                  }
                  setRelationshipFilter((prev) => ({
                    ...prev,
                    [index]: value,
                  }));
                }}
                onFocus={() => setOpenDropdown(index)}
                onBlur={() => {
                  // Delay closing to allow click on dropdown
                  setTimeout(() => setOpenDropdown(null), 200);
                }}
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "emergencyContacts-error" : undefined}
                aria-autocomplete="list"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
                list={`relationship-options-${index}`}
              />
              {openDropdown === index && (
                <div className="absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  {getFilteredRelationships(index).map((relationship) => (
                    <button
                      key={relationship}
                      type="button"
                      onClick={() => handleRelationshipChange(index, relationship)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-950 dark:text-zinc-50"
                    >
                      {relationship}
                    </button>
                  ))}
                  {getFilteredRelationships(index).length === 0 && (
                    <div className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400">
                      No matching relationships
                    </div>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() =>
                setContacts(contacts.filter((_, i) => i !== index))
              }
              aria-label={`Remove contact: ${contact.name || `Contact ${index + 1}`}`}
              className="shrink-0 rounded-md border border-zinc-300 px-3 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
            >
              &times;
            </button>
          </div>
          ))}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setContacts([...contacts, EMPTY_CONTACT])}
              disabled={contacts.length >= MAX_CONTACTS}
              className="text-sm font-medium text-zinc-950 underline disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none rounded px-1 dark:text-zinc-50 dark:focus:ring-zinc-600"
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
          {atLimit ? (
            <p
              id="contacts-limit-message"
              className="mt-1 text-sm text-zinc-500 dark:text-zinc-400"
            >
              Maximum of {MAX_CONTACTS} emergency contacts reached. Remove one
              to add another.
            </p>
          ) : null}
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
        </div>
      )}
      {error ? (
        <p
          id="emergencyContacts-error"
          className="mt-1 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
