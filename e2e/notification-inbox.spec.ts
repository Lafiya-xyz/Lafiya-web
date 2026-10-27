import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Notification inbox (#764): a new notification appears via Supabase
// Realtime without a page reload.

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `e2e-inbox-${Date.now()}@example.com`;
const password = "e2e-inbox-password-123";

test.describe("notification inbox", () => {
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

  test("shows a realtime notification without reload", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/signin");
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.getByTestId("signin-submit").click();
    await page.waitForURL("**/profile", { timeout: 30_000 });

    const inbox = page.getByTestId("notification-inbox");
    await expect(inbox).toContainText("(0 unread)");

    const { error } = await adminClient.from("user_notifications").insert({
      user_id: userId,
      event_key: `e2e-${userId}`,
      type: "break_glass_access",
      body_key: "notifications.break_glass_access",
    });
    if (error) throw error;

    await expect(inbox.getByTestId("notification-item")).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(inbox).toContainText("(1 unread)");

    await inbox.getByRole("button", { name: "Mark as read" }).click();
    await expect(inbox).toContainText("(0 unread)");
  });
});
