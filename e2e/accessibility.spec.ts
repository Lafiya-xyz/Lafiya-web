import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const INBUCKET_URL = "http://127.0.0.1:54324";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

async function signUpAndReachProfile(page: Page, email: string, password: string) {
  await page.goto("/signup");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.check("#consent");
  await page.click('button[type="submit"]');

  const infoMessage = page.getByText(/check your email/i);
  if (await infoMessage.isVisible({ timeout: 3000 }).catch(() => false)) {
    const confirmationLink = await getConfirmationLinkFromInbucket(email);
    expect(confirmationLink).not.toBeNull();
    await page.goto(confirmationLink!);

    await page.goto("/signin");
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click('button[type="submit"]');
  }

  await page.waitForURL("**/profile", { timeout: 30_000 });
}

// Any "serious" or "critical" finding fails the build. Lower-severity
// findings ("minor"/"moderate") are logged for visibility but don't block
// CI, since axe's confidence on those categories is lower and they're
// better handled as a backlog than a hard gate.
function assertNoSeriousViolations(
  results: Awaited<ReturnType<AxeBuilder["analyze"]>>,
  pageName: string,
) {
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const nonBlocking = results.violations.filter(
    (v) => v.impact !== "serious" && v.impact !== "critical",
  );
  if (nonBlocking.length > 0) {
    console.log(
      `[a11y] ${pageName}: ${nonBlocking.length} non-blocking finding(s):`,
      nonBlocking.map((v) => `${v.id} (${v.impact})`).join(", "),
    );
  }
  expect(
    blocking,
    `${pageName} has serious/critical a11y violations: ${blocking
      .map((v) => `${v.id} (${v.impact}): ${v.help}`)
      .join("; ")}`,
  ).toEqual([]);
}

test.describe("Accessibility scan (axe-core)", () => {
  test("sign-in page has no serious/critical violations", async ({ page }) => {
    await page.goto("/signin");
    const results = await new AxeBuilder({ page }).analyze();
    assertNoSeriousViolations(results, "sign-in");
  });

  test.describe("authenticated pages", () => {
    const email = `e2e-a11y-${Date.now()}@example.com`;
    const password = "e2e-test-password-123456";

    test.afterAll(async () => {
      await cleanupTestUser(email);
    });

    test("profile page has no serious/critical violations", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await signUpAndReachProfile(page, email, password);
      const results = await new AxeBuilder({ page }).analyze();
      assertNoSeriousViolations(results, "profile");
    });

    test("public card page has no serious/critical violations", async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      await signUpAndReachProfile(page, email, password);

      await page.fill("#name", "A11y Test Patient");
      await page.fill("#dateOfBirth", "1990-01-01");
      await page.selectOption("#bloodGroup", "O+");
      await page.selectOption("#genotype", "AA");
      await page.click('button:has-text("Save")');
      await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10000 });

      const publicConsent = page.locator("form", {
        hasText: "Public emergency card",
      });
      await publicConsent.getByRole("button", { name: "Allow" }).click();
      await expect(publicConsent.getByText("allowed")).toBeVisible();

      const cardUrlText = page.locator("p.break-all");
      await expect(cardUrlText).toBeVisible({ timeout: 10000 });
      const cardUrl = (await cardUrlText.textContent())?.trim();
      expect(cardUrl).toBeTruthy();

      const visitorContext = await context.browser()!.newContext();
      const visitorPage = await visitorContext.newPage();
      await visitorPage.goto(cardUrl!);
      await expect(
        visitorPage.getByRole("heading", { name: "A11y Test Patient" }),
      ).toBeVisible();

      const results = await new AxeBuilder({ page: visitorPage }).analyze();
      await visitorContext.close();
      assertNoSeriousViolations(results, "public card");
    });
  });
});
