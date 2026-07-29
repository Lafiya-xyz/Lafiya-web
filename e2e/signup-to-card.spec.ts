import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const INBUCKET_URL = "http://127.0.0.1:54324";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * If local Supabase requires email confirmation, the confirmation link
 * lands in Inbucket (local dev mail catcher). Poll for it and return the
 * link Playwright should visit to confirm the account.
 */
async function getConfirmationLinkFromInbucket(
  email: string,
): Promise<string | null> {
  const mailbox = email.split("@")[0];
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${INBUCKET_URL}/api/v1/mailbox/${mailbox}`);
    if (res.ok) {
      const messages = await res.json();
      if (messages.length > 0) {
        const latest = messages[messages.length - 1];
        const msgRes = await fetch(
          `${INBUCKET_URL}/api/v1/mailbox/${mailbox}/${latest.id}`,
        );
        const msg = await msgRes.json();
        const match = /(http:\/\/[^\s"]+)/.exec(msg.body.text ?? msg.body.html);
        if (match) {
          return match[1];
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function cleanupTestUser(email: string) {
  const { data } = await adminClient.auth.admin.listUsers();
  const user = data.users.find((u) => u.email === email);
  if (user) {
    await adminClient.auth.admin.deleteUser(user.id);
  }
}

test.describe("Golden path: signup → profile edit → QR scan → public card", () => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = "e2e-test-password-123456";

  test.afterAll(async () => {
    await cleanupTestUser(email);
  });

  test("a patient can sign up, fill their profile, and a responder can view the public card", async ({
    page,
    context,
  }) => {
    // --- 1. Sign up ---
    await page.goto("/signup");
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.check("#consent");
    await page.click('button[type="submit"]');

    // Handle both cases: immediate session, or email confirmation required.
    const infoMessage = page.getByText(/check your email/i);
    if (await infoMessage.isVisible({ timeout: 3000 }).catch(() => false)) {
      const confirmationLink = await getConfirmationLinkFromInbucket(email);
      expect(confirmationLink).not.toBeNull();
      await page.goto(confirmationLink!);

      // Confirmation alone may not create a session; sign in explicitly.
      await page.goto("/signin");
      await page.fill("#email", email);
      await page.fill("#password", password);
      await page.click('button[type="submit"]');
    }

    // --- 2. Should now be on the profile page ---
    await page.waitForURL("**/profile", { timeout: 15000 });

    // --- 3. Fill out the profile form ---
    await page.fill("#name", "E2E Test Patient");
    await page.fill("#dateOfBirth", "1990-01-01");
    await page.fill("#language", "Hausa");
    await page.selectOption("#bloodGroup", "O+");
    await page.selectOption("#genotype", "AA");

    await page.click('button:has-text("Save")');
    await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

    // --- 4. Grab the public card URL from the QR display ---
    const cardUrlText = page.locator("p.break-all");
    await expect(cardUrlText).toBeVisible({ timeout: 10000 });
    const cardUrl = (await cardUrlText.textContent())?.trim();
    expect(cardUrl).toBeTruthy();
    expect(cardUrl).toContain("/card/");

    // --- 5. Visit the public card as an unauthenticated visitor ---
    const visitorContext = await context.browser()!.newContext();
    const visitorPage: Page = await visitorContext.newPage();
    await visitorPage.goto(cardUrl!);

    await expect(
      visitorPage.getByRole("heading", { name: "E2E Test Patient" }),
    ).toBeVisible();
    await expect(visitorPage.getByText("O+")).toBeVisible();
    await expect(visitorPage.getByText("AA")).toBeVisible();

    await visitorContext.close();
  });
});