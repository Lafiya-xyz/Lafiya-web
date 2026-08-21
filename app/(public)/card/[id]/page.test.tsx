import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { after } from "next/server";
import PublicCardPage from "./page";

const VALID_ID = "11111111-1111-1111-1111-111111111111";
const fixtureCard = {
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
  commitment: "d".repeat(64),
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

describe("PublicCardPage", () => {
  it("renders only the emergency subset for a valid card", async () => {
    mockRpc({ data: [fixtureCard], error: null });

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
    expect(screen.getByText("28 years old")).toBeInTheDocument();
    expect(screen.getByText("O+")).toBeInTheDocument();
    expect(screen.getByText("AS")).toBeInTheDocument();
    expect(screen.getByText("Penicillin")).toBeInTheDocument();
    expect(screen.getByText("Insulin")).toBeInTheDocument();
    expect(screen.getByText("Asthma")).toBeInTheDocument();
    expect(screen.getByText(/Halima Yusuf/)).toBeInTheDocument();
    expect(screen.getByText("Hausa")).toBeInTheDocument();

    // Never leaks internal identifiers, only the emergency subset.
    expect(screen.queryByText(/user_id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(VALID_ID)).not.toBeInTheDocument();
  });

  it("schedules access accountability after rendering instead of awaiting it", async () => {
    mockRpc({ data: [fixtureCard], error: null });

    await expect(
      PublicCardPage({ params: Promise.resolve({ id: VALID_ID }) }),
    ).resolves.toBeDefined();

    // The callback is intentionally deferred. If its database write fails or
    // hangs, it cannot delay the emergency response rendered above.
    expect(after).toHaveBeenCalledWith(expect.any(Function));
  });

  it("passes axe-core accessibility audit", async () => {
    mockRpc({ data: [fixtureCard], error: null });

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    // Run axe against the document body to catch landmark violations
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  it("calls notFound for a malformed id without querying the database", async () => {
    await expect(
      PublicCardPage({ params: Promise.resolve({ id: "not-a-uuid" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls notFound when no card matches the id", async () => {
    mockRpc({ data: [], error: null });

    await expect(
      PublicCardPage({
        params: Promise.resolve({ id: "22222222-2222-2222-2222-222222222222" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("throws an unavailable error when the RPC errors, instead of notFound", async () => {
    mockRpc({ data: null, error: new Error("boom") });

    await expect(
      PublicCardPage({ params: Promise.resolve({ id: VALID_ID }) }),
    ).rejects.toThrow("UNAVAILABLE");
  });

  it("renders persisted unavailable status without calling a provider", async () => {
    mockRpc({
      data: [{ ...fixtureCard, trust_state: "unavailable" }],
      error: null,
    });

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
    expect(
      screen.getByText("Verification status unavailable"),
    ).toBeInTheDocument();
  });

  it("keeps emergency data visible for a persisted provider outage", async () => {
    mockRpc({
      data: [{ ...fixtureCard, trust_state: "unavailable" }],
      error: null,
    });

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    // Full emergency data must render — attestation outage must never block it
    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
    expect(screen.getByText("O+")).toBeInTheDocument();
    expect(screen.getByText("Penicillin")).toBeInTheDocument();
    // Degraded badge, not a broken page
    expect(
      screen.getByText("Verification status unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not yet verified")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Health-worker attestation finalized"),
    ).not.toBeInTheDocument();
  });

  it("does not infer trust from a commitment without finalized evidence", async () => {
    mockRpc({
      data: [
        { ...fixtureCard, trust_state: "unavailable", commitment: undefined },
      ],
      error: null,
    });

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
    expect(
      screen.getByText("Verification status unavailable"),
    ).toBeInTheDocument();
  });
});
