import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EmergencyCardContent } from "@/app/(public)/card/[id]/card-content";

const baseCard = {
  name: "Test Patient",
  age: 30,
  photo_url: null,
  blood_group: "O+" as const,
  genotype: "AA" as const,
  allergies: ["penicillin"],
  medications: ["insulin"],
  chronic_conditions: ["asthma"],
  emergency_contacts: [
    { name: "Jane Doe", phone: "+1234567890", relationship: "spouse" },
  ],
  language: "English",
  disclosure_states: {},
  schema_version: 1,
  offline_cache_allowed: true,
  trust_state: "verified" as const,
  trust_updated_at: new Date().toISOString(),
  record_updated_at: new Date().toISOString(),
  authorization_expires_at: new Date(Date.now() + 86400000).toISOString(),
};

describe("EmergencyCardContent last updated", () => {
  it("renders a last updated label", () => {
    const { container } = render(
      <EmergencyCardContent card={baseCard} authorizationKind="legacy" />
    );
    const text = container.innerHTML;
    expect(text).toContain("Last updated");
  });

  it("renders relative time for recent updates", () => {
    const { container } = render(
      <EmergencyCardContent card={{ ...baseCard, record_updated_at: new Date().toISOString() }} authorizationKind="legacy" />
    );
    const text = container.innerHTML;
    expect(text).toContain("Last updated");
    expect(text).toMatch(/Just now|\d+ second[s]? ago/);
  });

  it("renders an absolute date, not a relative one, for updates 7+ days old", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const { container } = render(
      <EmergencyCardContent card={{ ...baseCard, record_updated_at: oldDate.toISOString() }} authorizationKind="legacy" />
    );
    const text = container.innerHTML;
    const expectedDate = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(oldDate);
    expect(text).toContain("Last updated");
    expect(text).toContain(expectedDate);
    expect(text).not.toContain("days ago");
  });
});
