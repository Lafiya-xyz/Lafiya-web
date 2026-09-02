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
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const [relationshipFilter, setRelationshipFilter] = useState<Record<number, string>>({});

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
              placeholder="Phone"
              value={contact.phone}
              onChange={(event) =>
                updateContact(index, "phone", event.target.value)
              }
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "emergencyContacts-error" : undefined}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            <div className="relative w-full">
              <input
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
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
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
              disabled={contacts.length === 1}
              aria-label={`Remove contact: ${contact.name || `Contact ${index + 1}`}`}
              className="shrink-0 rounded-md border border-zinc-300 px-3 text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
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
        className="mt-2 text-sm font-medium text-zinc-950 underline disabled:opacity-40 dark:text-zinc-50"
      >
        + Add contact
      </button>
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
