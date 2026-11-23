/**
 * Issue #872: captive portals and zero-rated networks.
 *
 * A captive portal answers every request with HTTP 200 HTML. The service
 * worker must recognise that the response is not from Lafiya, render the
 * cached offline envelope with a "sign-in network" banner, and never cache
 * portal content. A slow (degraded) network must fall back within budget.
 *
 * The cached-envelope cases need a card that allows offline caching; set
 * E2E_OFFLINE_CARD_PATH (e.g. /card/<capability>) to run them.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const PORTAL_HTML =
  "<!doctype html><html><body><h1>Welcome to Free WiFi</h1><p>Sign in to continue</p></body></html>";
const CARD_PATH = process.env.E2E_OFFLINE_CARD_PATH;

async function waitForServiceWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    }
  });
}

async function enablePortal(context: BrowserContext) {
  await context.route("**/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: PORTAL_HTML,
    }),
  );
}

test.describe("captive portal detection", () => {
  test("uncached card behind a portal shows the captive banner, not portal content", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await waitForServiceWorker(page);
    await enablePortal(context);

    await page.goto("/card/00000000-0000-4000-8000-000000000000");
    await expect(page.locator('[data-connectivity="captive"]')).toBeVisible();
    await expect(page.getByText("Welcome to Free WiFi")).toHaveCount(0);
  });

  test("cached envelope and captive banner render behind a portal", async ({
    page,
    context,
  }) => {
    test.skip(!CARD_PATH, "E2E_OFFLINE_CARD_PATH not set");
    await page.goto(CARD_PATH!);
    await waitForServiceWorker(page);
    await page.reload(); // controlled navigation caches the envelope
    await enablePortal(context);

    await page.goto(CARD_PATH!);
    await expect(page.getByText("Cached emergency information.")).toBeVisible();
    await expect(page.locator('[data-connectivity="captive"]')).toBeVisible();

    const cachedPortal = await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const body = await (await cache.match(request))!.text();
          if (body.includes("Welcome to Free WiFi")) return true;
        }
      }
      return false;
    });
    expect(cachedPortal).toBe(false);
  });

  test("degraded network falls back to the cached envelope within budget", async ({
    page,
    context,
  }) => {
    test.skip(!CARD_PATH, "E2E_OFFLINE_CARD_PATH not set");
    await page.goto(CARD_PATH!);
    await waitForServiceWorker(page);
    await page.reload();
    await context.route("**/card/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route.continue().catch(() => {});
    });

    const started = Date.now();
    await page.goto(CARD_PATH!);
    await expect(page.getByText("Cached emergency information.")).toBeVisible();
    await expect(page.locator('[data-connectivity="degraded"]')).toBeVisible();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
