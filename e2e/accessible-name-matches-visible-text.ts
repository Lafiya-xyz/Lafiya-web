import type { Locator, Page } from "@playwright/test";

/**
 * Custom accessibility rule for issue #931.
 *
 * Voice-control and switch-access users activate controls by the words they
 * can see. When a control's computed accessible name does not contain its
 * visible text, those users cannot say what they see. This rule compares the
 * visible text of every interactive control against its accessible name and
 * reports a mismatch.
 *
 * The accessible name is computed with the browser's own accessibility tree
 * (Playwright's `ariaSnapshot`), so `aria-label`, `aria-labelledby`, `<label>`,
 * `alt` and text content are all honoured exactly as assistive tech sees them.
 */

export type NameMismatch = {
  selector: string;
  visibleText: string;
  accessibleName: string;
};

const CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
].join(",");

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Returns every control whose accessible name does not contain its visible
 * text. Controls with no visible text (icon-only) are skipped here: they are
 * covered by axe's `button-name`/`link-name` rules and by the icon-only
 * inventory in docs/accessibility-voice-control-audit.md.
 */
export async function findAccessibleNameMismatches(
  page: Page,
): Promise<NameMismatch[]> {
  const handles = await page.locator(CANDIDATE_SELECTOR).all();
  const mismatches: NameMismatch[] = [];

  for (const handle of handles) {
    if (!(await handle.isVisible())) continue;

    const visibleText = normalize(
      (await handle.innerText().catch(() => "")) ?? "",
    );
    if (!visibleText) continue;

    const snapshot = await handle.ariaSnapshot().catch(() => "");
    // ariaSnapshot renders `- role "accessible name":` for named nodes.
    const nameMatch = /^\s*-\s*[a-z]+(?:\s+"([^"]*)")?/i.exec(snapshot);
    const accessibleName = normalize(nameMatch?.[1] ?? "");
    if (!accessibleName) continue;

    if (!accessibleName.includes(visibleText)) {
      mismatches.push({
        selector: await describe(handle),
        visibleText,
        accessibleName,
      });
    }
  }

  return mismatches;
}

async function describe(handle: Locator): Promise<string> {
  return handle.evaluate((el: Element) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const testId = el.getAttribute("data-testid");
    const text = (el.textContent ?? "").trim().slice(0, 40);
    return testId ? `${tag}[data-testid="${testId}"]` : `${tag}${id} "${text}"`;
  });
}
