/**
 * e2e/device-cloud/critical-journeys.spec.ts
 *
 * Issue #954: the three critical journeys (scan → card, offline re-open, profile
 * edit) run nightly on real low-end Android devices in a device cloud.
 *
 * The device cloud (BrowserStack / LambdaTest / Sauce) drives this file through
 * its Playwright adapter, so the journeys are ordinary Playwright tests. The
 * device identity is injected by the runner as LAFIYA_DEVICE_LABEL (e.g.
 * "tecno-spark-8") and is attached to every test so failures can be triaged
 * with a device-specific label.
 *
 * The scan journey stubs the camera and the QR decoder: real low-end devices
 * have no reliable camera in a cloud farm, and the journey under test is
 * "a decoded card URL opens the card", not the decoder itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const DEVICE_LABEL = process.env.LAFIYA_DEVICE_LABEL ?? "unknown-device";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({}, testInfo) => {
  // Device-specific failure labels: every result carries the device it ran on.
  testInfo.annotations.push({ type: "device", description: DEVICE_LABEL });
});

async function createCard(): Promise<{ userId: string; cardId: string }> {
  const { data: userData, error: userError } =
    await adminClient.auth.admin.createUser({
      email: `device-cloud-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: "test-password-123456",
      email_confirm: true,
    });
  if (userError || !userData.user) {
    throw new Error(`Failed to create test user: ${userError?.message}`);
  }

  const { data: cardData, error: cardError } = await adminClient
    .from("emergency_cards")
    .insert({
      user_id: userData.user.id,
      name: "Device Cloud Patient",
      age: 41,
      blood_group: "O+",
      genotype: "AA",
      allergies: ["Penicillin"],
      medications: ["Amlodipine"],
      chronic_conditions: ["Hypertension"],
      emergency_contacts: [
        { name: "Ada Obi", relationship: "Sister", phone: "+234-555-0101" },
      ],
      language: "English",
      offline_cache_allowed: true,
      trust_state: "not_verified",
      authorization_expires_at: new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString(),
    })
    .select("id")
    .single();
  if (cardError || !cardData) {
    throw new Error(`Failed to create card: ${cardError?.message}`);
  }

  return { userId: userData.user.id, cardId: cardData.id as string };
}

async function cleanup(userId: string) {
  await adminClient.auth.admin.deleteUser(userId).catch(() => {});
}

/** Stub camera + decoder so the scan journey is deterministic on any device. */
async function stubScanner(page: Page, payload: string) {
  await page.addInitScript((decoded) => {
    const stream = {
      getTracks: () => [{ stop() {}, getCapabilities: () => ({}) }],
      getVideoTracks: () => [{ stop() {}, getCapabilities: () => ({}) }],
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector =
      class {
        static async getSupportedFormats() {
          return ["qr_code"];
        }
        async detect() {
          return [{ rawValue: decoded }];
        }
      };
  }, payload);
}

test("scan → card: a scanned card URL opens the emergency card", async ({
  page,
}) => {
  const { userId, cardId } = await createCard();
  try {
    await stubScanner(page, `/card/${cardId}`);
    await page.goto("/scan");

    await expect(page.getByText("Emergency Card Verified")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open Card" }).click();

    await expect(page.getByTestId("card-identity-name")).toHaveText(
      "Device Cloud Patient",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("card-blood-group")).toHaveText("O+");
  } finally {
    await cleanup(userId);
  }
});

test("offline re-open: a cached card renders without a network", async ({
  page,
  context,
}) => {
  const { userId, cardId } = await createCard();
  try {
    await page.goto(`/card/${cardId}`);
    await expect(page.getByTestId("card-identity-name")).toHaveText(
      "Device Cloud Patient",
    );

    // Wait for the service worker to cache the encrypted envelope.
    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return Boolean(reg?.active);
      },
      undefined,
      { timeout: 30_000 },
    );

    await context.setOffline(true);
    await page.reload();

    await expect(page.getByText(/Cached emergency information/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("O+")).toBeVisible();
    await expect(page.getByText("Penicillin")).toBeVisible();
  } finally {
    await context.setOffline(false);
    await cleanup(userId);
  }
});

test("profile edit: a signed-in patient can save a profile change", async ({
  page,
}) => {
  const email = `device-cloud-profile-${Date.now()}@example.com`;
  const password = "test-password-123456";
  const { data: created, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) {
    throw new Error(`Failed to create test user: ${error?.message}`);
  }

  try {
    await page.goto("/signin");
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.getByTestId("signin-submit").click();
    await page.waitForURL("**/profile", { timeout: 30_000 });

    await page.fill("#name", "Device Cloud Edited");
    await page.getByTestId("profile-save").click();
    await expect(page.getByTestId("profile-save-status")).toBeVisible({
      timeout: 20_000,
    });

    await page.reload();
    await expect(page.locator("#name")).toHaveValue("Device Cloud Edited", {
      timeout: 20_000,
    });
  } finally {
    await adminClient.auth.admin.deleteUser(created.user.id).catch(() => {});
  }
});
