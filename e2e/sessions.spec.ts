import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Active-session management (#523): a patient signed in on two devices can
// see both and sign the other one out; the revoked device is sent to /signin.

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `e2e-sessions-${Date.now()}@example.com`;
const password = "e2e-sessions-password-123";

async function signInOnNewDevice(
  browser: Browser,
  userAgent: string,
): Promise<Page> {
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();
  await page.goto("/signin");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByTestId("signin-submit").click();
  await page.waitForURL("**/profile", { timeout: 30_000 });
  return page;
}

test.describe("sessions panel", () => {
  let userId: string | undefined;

  test.beforeAll(async () => {
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user?.id;
  });

  test.afterAll(async () => {
    if (userId) await adminClient.auth.admin.deleteUser(userId);
  });

  test("lists both devices and signs the other one out", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const lostPhone = await signInOnNewDevice(
      browser,
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    );
    const laptop = await signInOnNewDevice(
      browser,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
    );

    await laptop.reload();
    const panel = laptop.getByTestId("sessions-panel");
    await expect(panel.getByTestId("session-item")).toHaveCount(2);
    await expect(panel).toContainText("Firefox on macOS");
    await expect(panel).toContainText("Chrome on Android");
    await expect(panel).toContainText("This device");

    const phoneRow = panel
      .getByTestId("session-item")
      .filter({ hasText: "Chrome on Android" });
    await phoneRow.getByTestId("session-revoke").click();
    await expect(panel.getByTestId("session-item")).toHaveCount(1);

    await lostPhone.goto("/profile");
    await expect(lostPhone).toHaveURL(/\/signin/);

    // The device that did the revoking is still signed in.
    await laptop.goto("/profile");
    await expect(laptop).toHaveURL(/\/profile$/);
  });
});
