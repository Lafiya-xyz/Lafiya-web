import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/emergency/card-pin-gate", () => ({
  getCapabilityPinGate: vi.fn().mockResolvedValue({
    withheld: [],
    canUnlock: false,
    locked: false,
    unlocked: false,
  }),
  getLegacyPinGatedFields: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/stellar/verification-indexer/trust-state", () => ({
  isAttestationTrustDegraded: vi.fn().mockResolvedValue(false),
}));

import { getCapabilityPinGate } from "@/lib/emergency/card-pin-gate";
import { createClient } from "@/lib/supabase/server";
import CapabilityCardPage from "./page";

const VALID_TOKEN = `lafiya_e1_${"a".repeat(43)}`;

const fixtureResolution = {
  access_state: "active",
  capability_id: "11111111-1111-1111-1111-111111111111",
  name: "Amina Yusuf",
  age: 28,
  photo_url: null,
  blood_group: "O+",
  genotype: "AS",
  allergies: ["Penicillin"],
  medications: ["Insulin"],
  chronic_conditions: ["Asthma"],
  emergency_contacts: [
    { name: "Halima Yusuf", phone: "+2348012345678", relationship: "Mother" },
  ],
  language: "Hausa",
  disclosure_states: {},
  schema_version: 1,
  offline_cache_allowed: true,
  trust_state: "unverified",
  trust_updated_at: null,
  record_updated_at: "2026-08-21T12:00:00.000Z",
  authorization_expires_at: "2026-12-31T12:00:00.000Z",
};

function mockRpc(result: { data: unknown; error: unknown }) {
  const fakeClient = { rpc: vi.fn().mockResolvedValue(result) };
  vi.mocked(createClient).mockResolvedValue(
    fakeClient as unknown as Awaited<ReturnType<typeof createClient>>,
  );
}

describe("CapabilityCardPage", () => {
  it("renders the card for an active capability", async () => {
    mockRpc({ data: [fixtureResolution], error: null });

    const jsx = await CapabilityCardPage({
      params: Promise.resolve({ token: VALID_TOKEN }),
    });
    render(jsx);

    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
  });

  it("never renders PIN-gated fields without a valid PIN (issue #631)", async () => {
    mockRpc({ data: [fixtureResolution], error: null });
    vi.mocked(getCapabilityPinGate).mockResolvedValueOnce({
      withheld: ["medications", "chronic_conditions"],
      canUnlock: true,
      locked: false,
      unlocked: false,
    });

    const { container } = render(
      await CapabilityCardPage({
        params: Promise.resolve({ token: VALID_TOKEN }),
      }),
    );
    const view = within(container);

    expect(container.innerHTML).not.toContain("Insulin");
    expect(container.innerHTML).not.toContain("Asthma");
    expect(view.getAllByText("Requires the card PIN")).toHaveLength(2);
    // Critical fields stay PIN-free.
    expect(view.getByText("Penicillin")).toBeInTheDocument();
    expect(view.getByText("O+")).toBeInTheDocument();
    expect(
      view.getByLabelText("6-digit PIN printed on the card"),
    ).toBeInTheDocument();
  });

  it("calls notFound for a malformed token without querying the database", async () => {
    await expect(
      CapabilityCardPage({ params: Promise.resolve({ token: "not-a-token" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls notFound when the token is unknown", async () => {
    mockRpc({
      data: [{ access_state: "not_found", capability_id: null }],
      error: null,
    });

    await expect(
      CapabilityCardPage({ params: Promise.resolve({ token: VALID_TOKEN }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each(["revoked", "expired", "exhausted"])(
    "shows a distinct expired/revoked message for access_state=%s, not the not-found page",
    async (accessState) => {
      mockRpc({
        data: [{ access_state: accessState, capability_id: null }],
        error: null,
      });

      const jsx = await CapabilityCardPage({
        params: Promise.resolve({ token: VALID_TOKEN }),
      });
      render(jsx);

      expect(
        screen.getByText("This link has expired or been revoked."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("This link could not be found."),
      ).not.toBeInTheDocument();
    },
  );

  it("throws an unavailable error when the RPC errors, instead of notFound", async () => {
    mockRpc({ data: null, error: new Error("boom") });

    await expect(
      CapabilityCardPage({ params: Promise.resolve({ token: VALID_TOKEN }) }),
    ).rejects.toThrow("UNAVAILABLE");
  });
});
