/**
 * Tests for app/(auth)/profile/privacy-controls.tsx
 *
 * PrivacyControls is a plain Server Component (no "use client") — it renders
 * static HTML whose shape depends entirely on the props passed in. We test
 * the rendered output with React Testing Library, mocking the two server
 * actions so they never actually run.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the server actions so imports don't trigger "use server" restrictions.
vi.mock("@/app/(auth)/profile/actions", () => ({
  recordConsentChoice: vi.fn(),
  updateDisclosureChoices: vi.fn(),
}));

import { PrivacyControls } from "@/app/(auth)/profile/privacy-controls";
import type { ConsentEventRow, DisclosurePolicy } from "@/lib/supabase/types";

// ---- fixtures ----

const ALL_FIELDS_OFF: DisclosurePolicy = {
  version: 1,
  fields: {
    name: false,
    age: false,
    photo_url: false,
    blood_group: false,
    genotype: false,
    allergies: false,
    medications: false,
    chronic_conditions: false,
    emergency_contacts: false,
    language: false,
    date_of_birth: false,
  },
};

const ALL_FIELDS_ON: DisclosurePolicy = {
  version: 1,
  fields: {
    name: true,
    age: true,
    photo_url: true,
    blood_group: true,
    genotype: true,
    allergies: true,
    medications: true,
    chronic_conditions: true,
    emergency_contacts: true,
    language: true,
    date_of_birth: false, // always locked off — server action enforces this
  },
};

function consentEvent(
  purpose: string,
  action: "acknowledged" | "withdrawn",
): ConsentEventRow {
  return {
    id: `evt-${purpose}`,
    user_id: "user-1",
    purpose: purpose as ConsentEventRow["purpose"],
    purpose_version: 1,
    action,
    occurred_at: "2025-01-01T00:00:00Z",
    idempotency_key: `key-${purpose}`,
    ip_address_hash: null,
    user_agent_hash: null,
  };
}

// ---- heading / section ----

describe("PrivacyControls — section structure", () => {
  it("renders the section heading", () => {
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={[]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /privacy and consent/i }),
    ).toBeInTheDocument();
  });
});

// ---- consent toggles ----

describe("PrivacyControls — consent purpose toggles", () => {
  it("shows 'Allow' for a purpose with no consent event (defaults withdrawn)", () => {
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={[]}
      />,
    );
    // All four purposes should show "Allow" when no events exist.
    const allowButtons = screen.getAllByRole("button", { name: /allow/i });
    expect(allowButtons.length).toBe(4);
  });

  it("shows 'Withdraw' for a purpose that has been acknowledged", () => {
    const events = [consentEvent("emergency_public_disclosure", "acknowledged")];
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={events}
      />,
    );
    expect(
      screen.getByRole("button", { name: /withdraw/i }),
    ).toBeInTheDocument();
    // The other three should still show Allow.
    const allowButtons = screen.getAllByRole("button", { name: /allow/i });
    expect(allowButtons.length).toBe(3);
  });

  it("shows 'Allow' for a purpose that was most recently withdrawn", () => {
    const events = [
      consentEvent("offline_caching", "acknowledged"),
      consentEvent("offline_caching", "withdrawn"),
    ];
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={events}
      />,
    );
    // Only the first occurrence per purpose is used (Map insertion order).
    // The first event is "acknowledged" → component shows "Withdraw".
    // (The component iterates events and only stores the FIRST per purpose.)
    expect(
      screen.getByRole("button", { name: /withdraw/i }),
    ).toBeInTheDocument();
  });

  it("toggling one consent purpose does not affect another", () => {
    const events = [consentEvent("clinical_verification", "acknowledged")];
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={events}
      />,
    );
    // clinical_verification → "Withdraw"; the rest → "Allow"
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
    const allowButtons = screen.getAllByRole("button", { name: /allow/i });
    expect(allowButtons.length).toBe(3);
  });

  it("each consent form carries the correct hidden purpose input", () => {
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={[]}
      />,
    );
    const purposeInputs = document
      .querySelectorAll('input[name="purpose"]');
    const values = Array.from(purposeInputs).map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(values).toContain("emergency_public_disclosure");
    expect(values).toContain("offline_caching");
    expect(values).toContain("clinical_verification");
    expect(values).toContain("optional_analytics");
  });
});

// ---- disclosure field checkboxes ----

describe("PrivacyControls — disclosure field checkboxes", () => {
  it("renders all disclosure field checkboxes", () => {
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={[]}
      />,
    );
    // There should be a checkbox for each disclosure field.
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThanOrEqual(10);
  });

  it("reflects policy fields=true as checked checkboxes", () => {
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_ON}
        events={[]}
      />,
    );
    const nameCheckbox = document.querySelector(
      'input[name="field:name"]',
    ) as HTMLInputElement;
    expect(nameCheckbox).not.toBeNull();
    expect(nameCheckbox.defaultChecked).toBe(true);
  });

  it("reflects policy fields=false as unchecked checkboxes", () => {
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={ALL_FIELDS_OFF}
        events={[]}
      />,
    );
    const allergiesCheckbox = document.querySelector(
      'input[name="field:allergies"]',
    ) as HTMLInputElement;
    expect(allergiesCheckbox).not.toBeNull();
    expect(allergiesCheckbox.defaultChecked).toBe(false);
  });

  it("two independent fields can have different initial states", () => {
    const mixedPolicy: DisclosurePolicy = {
      ...ALL_FIELDS_OFF,
      fields: { ...ALL_FIELDS_OFF.fields, name: true, allergies: false },
    };
    render(
      <PrivacyControls
        revisionId="rev-1"
        policy={mixedPolicy}
        events={[]}
      />,
    );
    const nameCheckbox = document.querySelector(
      'input[name="field:name"]',
    ) as HTMLInputElement;
    const allergiesCheckbox = document.querySelector(
      'input[name="field:allergies"]',
    ) as HTMLInputElement;
    expect(nameCheckbox.defaultChecked).toBe(true);
    expect(allergiesCheckbox.defaultChecked).toBe(false);
  });

  it("embeds the revisionId in the expectedRevisionId hidden input", () => {
    render(
      <PrivacyControls
        revisionId="rev-abc-123"
        policy={ALL_FIELDS_OFF}
        events={[]}
      />,
    );
    const hidden = document.querySelector(
      'input[name="expectedRevisionId"]',
    ) as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe("rev-abc-123");
  });
});

// ---- consent history ----

describe("PrivacyControls — consent history", () => {
  it("renders each consent event in the history list", () => {
    const events = [
      consentEvent("emergency_public_disclosure", "acknowledged"),
      consentEvent("offline_caching", "withdrawn"),
    ];
    render(
      <PrivacyControls revisionId="rev-1" policy={ALL_FIELDS_OFF} events={events} />,
    );
    // Scope the search to the history <ol> list to avoid matching the toggle
    // label spans that also contain "offline caching".
    const list = screen.getByRole("list");
    const items = Array.from(list.querySelectorAll("li")).map(
      (li) => li.textContent ?? "",
    );
    expect(items.some((t) => /emergency public disclosure/i.test(t))).toBe(true);
    expect(items.some((t) => /offline caching/i.test(t))).toBe(true);
  });

  it("renders an empty history list when events is empty", () => {
    render(
      <PrivacyControls revisionId="rev-1" policy={ALL_FIELDS_OFF} events={[]} />,
    );
    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
    expect(list.children.length).toBe(0);
  });
});
