import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/stellar/attestation", () => ({
  validateAttestation: vi.fn(),
}));
vi.mock("@/lib/attestation/recordSecret", () => ({
  getSecretByCardPublicId: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { createClient } from "@/lib/supabase/server";
import { getSecretByCardPublicId } from "@/lib/attestation/recordSecret";
import { validateAttestation } from "@/lib/stellar/attestation";

import PublicCardPage from "./page";

const VALID_ID = "11111111-1111-1111-1111-111111111111";
const FIXTURE_SECRET = "c".repeat(64);

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
    vi.mocked(getSecretByCardPublicId).mockResolvedValue(FIXTURE_SECRET);
    vi.mocked(validateAttestation).mockResolvedValue(false);

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

  it("passes axe-core accessibility audit", async () => {
    mockRpc({ data: [fixtureCard], error: null });
    vi.mocked(getSecretByCardPublicId).mockResolvedValue(FIXTURE_SECRET);
    vi.mocked(validateAttestation).mockResolvedValue(false);

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

  it("renders with unavailable status when attestation lookup fails", async () => {
    mockRpc({ data: [fixtureCard], error: null });
    vi.mocked(getSecretByCardPublicId).mockResolvedValue(FIXTURE_SECRET);
    vi.mocked(validateAttestation).mockRejectedValue(new Error("RPC failed"));

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
    expect(
      screen.getByText("Verification status unavailable"),
    ).toBeInTheDocument();
  });

  it("renders with unavailable status when attestation lookup times out (simulates RPC hang + internal timeout)", async () => {
    // The real getAttestation enforces ATTESTATION_TIMEOUT_MS internally and
    // rejects with an "Attestation RPC timeout" error when the Soroban RPC
    // hangs; validateAttestation propagates that rejection. This test mocks
    // that rejection to assert the card page still renders all emergency
    // data with a degraded badge — not a crash.
    mockRpc({ data: [fixtureCard], error: null });
    vi.mocked(getSecretByCardPublicId).mockResolvedValue(FIXTURE_SECRET);
    vi.mocked(validateAttestation).mockRejectedValue(
      new Error("Attestation RPC timeout"),
    );

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
      screen.queryByText("Verified by a health worker"),
    ).not.toBeInTheDocument();
  });

  it("renders with unavailable status when no record secret exists for the card", async () => {
    // A card whose profile_secrets row is missing (should never happen in
    // practice post-backfill/post-upsertProfile, but must degrade safely,
    // not crash, if it ever does).
    mockRpc({ data: [{ ...fixtureCard, commitment: undefined }], error: null });
    vi.mocked(getSecretByCardPublicId).mockResolvedValue(null);

    const jsx = await PublicCardPage({
      params: Promise.resolve({ id: VALID_ID }),
    });
    render(jsx);

    expect(screen.getByText("Amina Yusuf")).toBeInTheDocument();
    expect(
      screen.getByText("Verification status unavailable"),
    ).toBeInTheDocument();
    expect(validateAttestation).not.toHaveBeenCalled();
  });
});
