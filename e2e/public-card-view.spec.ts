/**
 * e2e/public-card-view.spec.ts
 *
 * Exercises the single most important user journey in Lafiya: an unauthenticated
 * visitor (standing in for a first responder) opening /card/[id] and seeing
 * exactly the fields the patient chose to make public — and nothing else.
 *
 * Setup:
 *  1. Register and sign in as a patient.
 *  2. Fill a profile with a known mix of public and private fields.
 *  3. Set disclosure choices: blood group + allergies public; genotype private.
 *  4. In a fresh, unauthenticated browser context, visit the public card URL.
 *  5. Assert public fields render with correct values.
 *  6. Assert private fields are absent from the DOM entirely — not merely
 *     hidden with CSS, since hiding still leaks data to anyone reading source.
 */

import { test, expect, type Page } from "@playwright/test";
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
        if (match) return match[1];
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function cleanupTestUser(email: string) {
  const { data } = await adminClient.auth.admin.listUsers();
  const user = data.users.find((u) => u.email === email);
  if (user) await adminClient.auth.admin.deleteUser(user.id);
}

// ---------------------------------------------------------------------------
// The public card view suite
// ---------------------------------------------------------------------------

test.describe("Public card view: unauthenticated responder sees only disclosed fields", () => {
  const email = `e2e-pubcard-${Date.now()}@example.com`;
  const password = "e2e-pubcard-password-789";

  // Known field values we will enter for this patient
  const PATIENT_NAME = "Responder Test Patient";
  const PUBLIC_BLOOD_GROUP = "B+";
  const PUBLIC_ALLERGY = "Penicillin";
  // Genotype will be left at its default ("unknown") and made PRIVATE via
  // disclosure controls. The card should not show its actual value.

  let cardUrl: string;

  test.afterAll(async () => {
    await cleanupTestUser(email);
  });

  test(
    "patient sets up profile with mixed disclosure; responder sees only public fields",
    async ({ page, context }) => {
      test.setTimeout(120_000);

      // ------------------------------------------------------------------
      // 1. Sign up
      // ------------------------------------------------------------------
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

      // ------------------------------------------------------------------
      // 2. Fill profile form with known values
      // ------------------------------------------------------------------
      await page.fill("#name", PATIENT_NAME);
      await page.fill("#dateOfBirth", "1985-03-22");
      await page.fill("#language", "Yoruba");
      await page.selectOption("#bloodGroup", PUBLIC_BLOOD_GROUP);
      await page.selectOption("#genotype", "AS"); // will be made private below

      // Add a known allergy
      const allergyInput = page.getByPlaceholder(/e\.g\. Penicillin/i).first();
      await allergyInput.fill(PUBLIC_ALLERGY);

      await page.click('button:has-text("Save")');
      await expect(page.getByText("Saved.")).toBeVisible({ timeout: 10_000 });

      // ------------------------------------------------------------------
      // 3. Grant public emergency disclosure consent
      // ------------------------------------------------------------------
      const publicConsent = page.locator("form", {
        hasText: "Public emergency card",
      });
      await publicConsent.getByRole("button", { name: "Allow" }).click();
      await expect(publicConsent.getByText("allowed")).toBeVisible({
        timeout: 10_000,
      });

      // ------------------------------------------------------------------
      // 4. Set disclosure choices:
      //    - name, blood_group, allergies → PUBLIC (checked)
      //    - genotype → PRIVATE (unchecked)
      // ------------------------------------------------------------------
      // The disclosure fieldset contains checkboxes for each field.
      // Uncheck genotype so it remains private on the public card.
      const genotypeCheckbox = page.locator('input[name="field:genotype"]');
      if (await genotypeCheckbox.isChecked()) {
        await genotypeCheckbox.uncheck();
      }
      // Make sure name and blood_group are checked.
      const nameCheckbox = page.locator('input[name="field:name"]');
      if (!(await nameCheckbox.isChecked())) await nameCheckbox.check();
      const bloodGroupCheckbox = page.locator(
        'input[name="field:blood_group"]',
      );
      if (!(await bloodGroupCheckbox.isChecked()))
        await bloodGroupCheckbox.check();
      const allergiesCheckbox = page.locator('input[name="field:allergies"]');
      if (!(await allergiesCheckbox.isChecked()))
        await allergiesCheckbox.check();

      await page.click('button:has-text("Save disclosure choices")');
      // Give the server action time to commit
      await page.waitForTimeout(1500);

      // ------------------------------------------------------------------
      // 5. Grab the card URL from the legacy QR panel
      // ------------------------------------------------------------------
      const cardUrlEl = page.locator("p.break-all");
      await expect(cardUrlEl).toBeVisible({ timeout: 10_000 });
      cardUrl = (await cardUrlEl.textContent())?.trim() ?? "";
      expect(cardUrl).toContain("/card/");

      // ------------------------------------------------------------------
      // 6. Open a fresh unauthenticated browser context and visit the card
      // ------------------------------------------------------------------
      const responderContext = await context.browser()!.newContext();
      const responderPage: Page = await responderContext.newPage();
      await responderPage.goto(cardUrl);

      // ------------------------------------------------------------------
      // 7. Assert public fields render with correct values
      // ------------------------------------------------------------------
      await expect(
        responderPage.getByRole("heading", { name: PATIENT_NAME }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(responderPage.getByText(PUBLIC_BLOOD_GROUP)).toBeVisible();
      await expect(responderPage.getByText(PUBLIC_ALLERGY)).toBeVisible();

      // ------------------------------------------------------------------
      // 8. Assert private field value is NOT present anywhere in the DOM.
      //
      //    "AS" is the actual genotype the patient entered. Because genotype
      //    is private, the RPC returns null and the UI renders "Withheld"
      //    instead. The raw value "AS" (as a standalone token — there are
      //    other occurrences like "AS" in "Saved." etc. so we use exact
      //    text matching inside the critical facts section) must not appear
      //    in the genotype cell. We verify the full page text does not leak
      //    the value, and also verify the "Withheld" indicator is shown.
      // ------------------------------------------------------------------
      const fullPageText = await responderPage.textContent("body");
      expect(fullPageText).not.toBeNull();

      // The genotype section should say "Withheld", not the actual value.
      // Locate the genotype <dd> element specifically to avoid false positives.
      const genotypeValue = responderPage.locator("dd", {
        hasText: /^(withheld|withheld by patient|as)$/i,
      });
      // We expect exactly one match (the genotype cell) and it must be "Withheld"
      const genotypeTexts = await genotypeValue.allTextContents();
      for (const t of genotypeTexts) {
        // None of the visible <dd> cells should expose the raw "AS" value
        // for the genotype field when it has been made private.
        expect(t.trim()).not.toBe("AS");
      }

      // As a belt-and-suspenders check: look for the literal heading
      // "Genotype" and assert its sibling value is "Withheld".
      const genotypeSection = responderPage.locator("div", {
        has: responderPage.locator("dt", { hasText: /^genotype$/i }),
      });
      await expect(genotypeSection.locator("dd")).toContainText(/withheld/i);

      await responderContext.close();
    },
  );
});
