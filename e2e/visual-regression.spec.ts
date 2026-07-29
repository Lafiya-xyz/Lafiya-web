import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Duplicated from lib/attestation/recordHash.ts rather than imported: that
// module also exports validateAttestation, which pulls in
// lib/stellar/attestation.ts -> lib/env-server.ts -> the "server-only"
// package. That guard throws unconditionally unless the "react-server"
// resolve condition is set, which Playwright's plain Node test process
// never sets (only Next.js's RSC build does) — so importing it here would
// crash every test file, not just this one. Keep this in sync with the
// real implementation if the canonicalization ever changes.
function computeRecordHash(card: {
  name: string;
  age: number | null;
  blood_group: string;
  genotype: string;
  allergies: string[];
  medications: string[];
  chronic_conditions: string[];
  emergency_contacts: Array<{ name: string; phone: string; relationship: string }>;
  language: string | null;
}): string {
  const canonical = JSON.stringify({
    name: card.name,
    age: card.age,
    bloodGroup: card.blood_group,
    genotype: card.genotype,
    allergies: [...card.allergies].sort(),
    medications: [...card.medications].sort(),
    chronicConditions: [...card.chronic_conditions].sort(),
    emergencyContacts: [...card.emergency_contacts]
      .map((contact) => ({
        name: contact.name,
        phone: contact.phone,
        relationship: contact.relationship,
      }))
      .sort((a, b) =>
        `${a.name}${a.phone}`.localeCompare(`${b.name}${b.phone}`),
      ),
    language: card.language,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const testCard = {
  name: "Visual Regression Patient",
  date_of_birth: "1990-01-01",
  blood_group: "O+" as const,
  genotype: "AA" as const,
  allergies: ["Penicillin"],
  medications: ["Insulin"],
  chronic_conditions: ["Asthma"],
  emergency_contacts: [
    { name: "Test Contact", phone: "+2348000000000", relationship: "Sister" },
  ],
  language: "Hausa",
};

let userId: string;
let cardPublicId: string;

test.describe("Visual regression: public card + verified badge", () => {
  test.beforeAll(async () => {
    const email = `visual-${Date.now()}@example.com`;
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password: "visual-test-password-123456",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("user create failed");
    userId = data.user.id;

    const { data: profile, error: insertError } = await adminClient
      .from("profiles")
      .insert({ user_id: userId, ...testCard })
      .select("card_public_id")
      .single();
    if (insertError || !profile) throw insertError;
    cardPublicId = profile.card_public_id;

    // Fetch back via the same RPC the real page uses, so the hash we
    // compute here matches exactly what the server computes.
    const { data: rpcRows, error: rpcError } = await adminClient.rpc(
      "get_emergency_card",
      { p_card_id: cardPublicId },
    );
    if (rpcError || !rpcRows?.[0]) throw rpcError;

    const recordHash = computeRecordHash(rpcRows[0]);

    const res = await fetch(`http://localhost:3000/api/attestation/${recordHash}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordHash }),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to seed mock attestation: ${res.status} ${await res.text()}`,
      );
    }
  });

  test.afterAll(async () => {
    await adminClient.auth.admin.deleteUser(userId);
  });

  const viewports = [
    { name: "mobile", width: 375, height: 812 },
    { name: "desktop", width: 1280, height: 900 },
  ];
  const schemes: Array<"light" | "dark"> = ["light", "dark"];

  for (const viewport of viewports) {
    for (const scheme of schemes) {
      test(`card page — verified — ${viewport.name} — ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await page.goto(`/card/${cardPublicId}`);
        await expect(
          page.getByText("Verified by a health worker"),
        ).toBeVisible();
        await expect(page).toHaveScreenshot(
          `card-verified-${viewport.name}-${scheme}.png`,
          { fullPage: true },
        );
      });
    }
  }

  // A freshly-seeded, unrelated card's hash will not match anything in the
  // mock map, so this naturally reaches the "not_verified" state — no
  // extra seeding needed for this half of the coverage.
  let unverifiedCardId: string;
  let unverifiedUserId: string;

  test.beforeAll(async () => {
    const email = `visual-unverified-${Date.now()}@example.com`;
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password: "visual-test-password-123456",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("user create failed");
    unverifiedUserId = data.user.id;

    const { data: profile, error: insertError } = await adminClient
      .from("profiles")
      .insert({
        user_id: unverifiedUserId,
        ...testCard,
        name: "Unverified Visual Patient",
      })
      .select("card_public_id")
      .single();
    if (insertError || !profile) throw insertError;
    unverifiedCardId = profile.card_public_id;
  });

  test.afterAll(async () => {
    await adminClient.auth.admin.deleteUser(unverifiedUserId);
  });

  for (const viewport of viewports) {
    for (const scheme of schemes) {
      test(`card page — not verified — ${viewport.name} — ${scheme}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await page.goto(`/card/${unverifiedCardId}`);
        await expect(page.getByText("Not yet verified")).toBeVisible();
        await expect(page).toHaveScreenshot(
          `card-not-verified-${viewport.name}-${scheme}.png`,
          { fullPage: true },
        );
      });
    }
  }
});