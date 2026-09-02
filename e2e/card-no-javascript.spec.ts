import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Insert a test emergency card directly into Supabase for JS-disabled testing.
 * Returns the card ID (UUID) that can be used to access /card/[id].
 */
async function createTestCard(): Promise<string> {
  const { data: userData, error: userError } =
    await adminClient.auth.admin.createUser({
      email: `card-nojs-${Date.now()}@example.com`,
      password: "test-password-123456",
      email_confirm: true,
    });

  if (userError || !userData.user) {
    throw new Error(`Failed to create test user: ${userError?.message}`);
  }

  const userId = userData.user.id;

  // Insert an emergency card record
  const { data: cardData, error: cardError } = await adminClient
    .from("emergency_cards")
    .insert({
      user_id: userId,
      name: "Test Patient NoJS",
      age: 35,
      blood_group: "B+",
      genotype: "AS",
      allergies: ["Aspirin", "Shellfish"],
      medications: ["Metformin"],
      chronic_conditions: ["Diabetes", "Hypertension"],
      emergency_contacts: [
        {
          name: "John Doe",
          relationship: "Spouse",
          phone: "+1-555-0100",
        },
      ],
      language: "English",
      offline_cache_allowed: true,
      trust_state: "not_verified",
      authorization_expires_at: new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000
      ).toISOString(),
    })
    .select("id")
    .single();

  if (cardError || !cardData) {
    throw new Error(`Failed to create test card: ${cardError?.message}`);
  }

  return cardData.id;
}

/**
 * Clean up test card and user after the test.
 */
async function cleanupTestCard(cardId: string) {
  // Get the user_id from the card
  const { data: card } = await adminClient
    .from("emergency_cards")
    .select("user_id")
    .eq("id", cardId)
    .single();

  if (card?.user_id) {
    // Delete the card
    await adminClient.from("emergency_cards").delete().eq("id", cardId);

    // Delete the user
    await adminClient.auth.admin.deleteUser(card.user_id);
  }
}

test.describe("Emergency card with JavaScript disabled", () => {
  let cardId: string;

  test.beforeAll(async () => {
    cardId = await createTestCard();
  });

  test.afterAll(async () => {
    await cleanupTestCard(cardId);
  });

  test("core patient data renders server-side without client JavaScript", async ({
    browser,
  }) => {
    // Create a context with JavaScript disabled
    const context: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
    });

    const page = await context.newPage();

    // Navigate to the public card page
    await page.goto(`/card/${cardId}`);

    // Verify the page actually loaded (should not get 404)
    expect(page.status).toBeLessThan(400);

    // Core identity and critical emergency data should be visible WITHOUT JavaScript
    // These are rendered server-side and do not require client-side React hydration
    await expect(page.getByRole("heading", { name: "Test Patient NoJS" })).toBeVisible(
      { timeout: 5000 }
    );

    // Age
    await expect(page.getByText("35 years old")).toBeVisible({ timeout: 5000 });

    // Critical emergency information: blood group and genotype
    await expect(page.getByText(/Blood group/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("B+")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Genotype/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("AS")).toBeVisible({ timeout: 5000 });

    // Clinical details: allergies, medications, conditions
    await expect(page.getByText(/Allergies/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Aspirin/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Shellfish/)).toBeVisible({ timeout: 5000 });

    await expect(page.getByText(/Current medications/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Metformin/)).toBeVisible({ timeout: 5000 });

    await expect(page.getByText(/Chronic conditions/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Diabetes/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Hypertension/)).toBeVisible({ timeout: 5000 });

    // Emergency contacts
    await expect(page.getByText(/Emergency contacts/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("John Doe")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Spouse/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/\+1-555-0100/)).toBeVisible({ timeout: 5000 });

    // Language
    await expect(page.getByText(/Language spoken/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("English")).toBeVisible({ timeout: 5000 });

    await context.close();
  });

  test("verification badge renders even without JavaScript", async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
    });

    const page = await context.newPage();
    await page.goto(`/card/${cardId}`);

    // The verification badge should be visible — it's either a colored badge
    // or a fallback message, all server-rendered
    const badgeContent = await page.textContent("span");
    expect(badgeContent).toBeTruthy();
    // Either "Not yet verified" or some other verification status message
    const content = await page.content();
    expect(content).toMatch(
      /verified|unavailable|submitted|confirming|expired|revoked/i
    );

    await context.close();
  });

  test("record metadata (update times) renders without JavaScript", async ({ browser }) => {
    const context: BrowserContext = await browser.newContext({
      javaScriptEnabled: false,
    });

    const page = await context.newPage();
    await page.goto(`/card/${cardId}`);

    // Record metadata section should be visible
    await expect(page.getByText(/Record updated/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Authorization valid until/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Verification last checked/i)).toBeVisible({ timeout: 5000 });

    // These should show actual dates/times (not "Unavailable")
    const pageText = await page.textContent("body");
    expect(pageText).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/); // Date pattern

    await context.close();
  });
});
