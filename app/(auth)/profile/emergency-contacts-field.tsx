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
              placeholder="Phone"
              value={contact.phone}
              onChange={(event) =>
                updateContact(index, "phone", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
            <label htmlFor={`contact-relationship-${index}`} className="sr-only">
              Emergency contact {index + 1} relationship
            </label>
            <input
              id={`contact-relationship-${index}`}
              type="text"
              placeholder="Relationship"
              value={contact.relationship}
              onChange={(event) =>
                updateContact(index, "relationship", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
            <button
              type="button"
              onClick={() =>
                setContacts(contacts.filter((_, i) => i !== index))
              }
              disabled={contacts.length === 1}
              aria-label="Remove emergency contact"
              className="shrink-0 rounded-md border border-zinc-300 px-3 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setContacts([...contacts, EMPTY_CONTACT])}
        disabled={contacts.length >= MAX_CONTACTS}
        className="mt-2 text-sm font-medium text-zinc-950 underline disabled:opacity-40 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none rounded px-1 dark:text-zinc-50 dark:focus:ring-zinc-600"
      >
        + Add contact
      </button>
      {error ? (
        <p id="emergencyContacts-error" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
