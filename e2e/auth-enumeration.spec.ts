import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Account-enumeration resistance (#527): an attacker using the real forms
// must see the same page for an email that has a Lafiya account and one that
// does not.

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const password = "e2e-enumeration-password-123";

async function submitSignUp(page: Page, email: string) {
  await page.goto("/signup");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.check("#consent");
  await page.getByTestId("signup-submit").click();
  const message = page.getByText(/check your email/i);
  await expect(message).toBeVisible({ timeout: 15_000 });
  return { text: await message.textContent(), url: page.url() };
}

async function submitSignIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.fill("#email", email);
  await page.fill("#password", "wrong-password-for-sure");
  await page.getByTestId("signin-submit").click();
  const message = page.getByText("Incorrect email or password.");
  await expect(message).toBeVisible({ timeout: 15_000 });
  return { text: await message.textContent(), url: page.url() };
}

test.describe("auth account-enumeration resistance", () => {
  const existingEmail = `e2e-enum-existing-${Date.now()}@example.com`;
  let existingUserId: string | undefined;

  test.beforeAll(async () => {
    const { data, error } = await adminClient.auth.admin.createUser({
      email: existingEmail,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    existingUserId = data.user?.id;
  });

  test.afterAll(async () => {
    const { data } = await adminClient.auth.admin.listUsers();
    for (const user of data.users) {
      if (user.email?.startsWith("e2e-enum-")) {
        await adminClient.auth.admin.deleteUser(user.id);
      }
    }
    if (existingUserId) {
      await adminClient.auth.admin.deleteUser(existingUserId).catch(() => {});
    }
  });

  test("sign-up shows the same message and stays on /signup for existing and new emails", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const existing = await submitSignUp(page, existingEmail);
    const fresh = await submitSignUp(
      page,
      `e2e-enum-new-${Date.now()}@example.com`,
    );

    expect(existing.text).toBe(fresh.text);
    expect(new URL(existing.url).pathname).toBe("/signup");
    expect(new URL(fresh.url).pathname).toBe("/signup");
  });

  test("sign-in shows the same error for a wrong password and an unknown email", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const existing = await submitSignIn(page, existingEmail);
    const unknown = await submitSignIn(
      page,
      `e2e-enum-unknown-${Date.now()}@example.com`,
    );

    expect(existing.text).toBe(unknown.text);
    expect(new URL(existing.url).pathname).toBe("/signin");
    expect(new URL(unknown.url).pathname).toBe("/signin");
  });
});
