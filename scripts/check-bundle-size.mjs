#!/usr/bin/env node
/**
 * scripts/check-bundle-size.mjs
 *
 * Checks that the JS and CSS chunks for the public emergency card route stay
 * within the budgets defined in docs/perf-budget.md.
 *
 * Called from CI after `npm run build`. Exits non-zero on a budget violation
 * so the build fails fast instead of silently bloating over time.
 *
 * Design notes:
 *  - Uses only Node built-ins (no extra dependencies).
 *  - Reads .next/build-manifest.json (always present after `next build`) to
 *    discover which chunk files belong to the card route, then sums their
 *    sizes from .next/static/.
 *  - Thresholds are set a little above the perf-budget.md targets to avoid
 *    noise from minor framework version bumps:
 *      JS  budget: 60 kB  (target ≤ 50 kB)
 *      CSS budget: 20 kB  (target ≤ 15 kB)
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const NEXT_DIR = join(ROOT, ".next");

// ─── Thresholds ──────────────────────────────────────────────────────────────
const JS_BUDGET_BYTES = 60 * 1024; // 60 kB
const CSS_BUDGET_BYTES = 20 * 1024; // 20 kB

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fileSize(relativePath) {
  const abs = join(NEXT_DIR, relativePath.replace(/^\/_next\//, ""));
  try {
    return statSync(abs).size;
  } catch {
    // Chunk file listed in manifest but not on disk — treat as 0 and warn.
    console.warn(`  ⚠ chunk not found on disk: ${abs}`);
    return 0;
  }
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1) + " kB";
}

// ─── Load build manifest ─────────────────────────────────────────────────────
let manifest;
try {
  manifest = JSON.parse(
    readFileSync(join(NEXT_DIR, "build-manifest.json"), "utf8"),
  );
} catch {
  console.error(
    "✗ .next/build-manifest.json not found. Run `npm run build` first.",
  );
  process.exit(1);
}

// ─── Find the card route key ─────────────────────────────────────────────────
// The route group segment "(public)" is stripped from manifest keys in some
// Next.js versions; try both forms.
const ROUTE_KEYS = ["/(public)/card/[id]", "/card/[id]", "(public)/card/[id]"];

let routeKey = null;
for (const key of ROUTE_KEYS) {
  if (manifest.pages?.[key] ?? manifest.rootMainFiles) {
    if (key in (manifest.pages ?? {})) {
      routeKey = key;
      break;
    }
  }
}

if (!routeKey) {
  // Fall back: look for any key that ends with "card/[id]"
  routeKey = Object.keys(manifest.pages ?? {}).find((k) =>
    k.endsWith("card/[id]"),
  );
}

if (!routeKey) {
  console.error(
    "✗ Could not find the card/[id] route in .next/build-manifest.json.",
  );
  console.error("  Known pages:", Object.keys(manifest.pages ?? {}).join(", "));
  process.exit(1);
}

// ─── Sum JS chunk sizes ───────────────────────────────────────────────────────
const jsChunks = manifest.pages[routeKey] ?? [];
const jsBytes = jsChunks.reduce((sum, chunk) => sum + fileSize(chunk), 0);

// ─── Sum CSS chunk sizes ──────────────────────────────────────────────────────
// Next.js stores CSS chunk paths in the cssFiles field of the page-client-manifest
// (Next 13+) or as /_next/static/css/*.css entries referenced from the route.
// The simplest cross-version approach: read the pages-manifest and look for CSS
// in the same directory as the JS chunks, then also scan the static/css/ dir for
// files that reference this route.
let cssBytes = 0;

// Try the client-reference-manifest / CSS manifest approach.
const cssManifestPath = join(NEXT_DIR, "static", "css");
try {
  const { readdirSync } = await import("node:fs");
  const cssFiles = readdirSync(cssManifestPath);
  // We attribute all CSS files to the route budget because on this minimal app
  // the only route-specific CSS is from the card page. This is conservative
  // (shared CSS would also be counted) but correct for CI regression detection.
  cssBytes = cssFiles
    .filter((f) => f.endsWith(".css"))
    .reduce((sum, f) => {
      try {
        return sum + statSync(join(cssManifestPath, f)).size;
      } catch {
        return sum;
      }
    }, 0);
} catch {
  console.warn("  ⚠ Could not read .next/static/css/ — skipping CSS check.");
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log("\n── Bundle size check: card/[id] route ──────────────────────");
console.log(`  Route key: ${routeKey}`);
console.log(`  JS  chunks: ${jsChunks.length} files → ${kb(jsBytes)}`);
console.log(`  CSS chunks: ${kb(cssBytes)}`);
console.log(
  `  Budgets:    JS ≤ ${kb(JS_BUDGET_BYTES)} | CSS ≤ ${kb(CSS_BUDGET_BYTES)}`,
);

let failed = false;

if (jsBytes > JS_BUDGET_BYTES) {
  console.error(
    `\n✗ JS budget exceeded: ${kb(jsBytes)} > ${kb(JS_BUDGET_BYTES)}`,
  );
  console.error(
    "  Check for accidental client-component imports or new large dependencies.",
  );
  failed = true;
} else {
  console.log(`\n✓ JS within budget (${kb(jsBytes)} ≤ ${kb(JS_BUDGET_BYTES)})`);
}

if (cssBytes > CSS_BUDGET_BYTES) {
  console.error(
    `✗ CSS budget exceeded: ${kb(cssBytes)} > ${kb(CSS_BUDGET_BYTES)}`,
  );
  console.error(
    "  Check for new CSS imports or utilities added to the card route.",
  );
  failed = true;
} else {
  console.log(
    `✓ CSS within budget (${kb(cssBytes)} ≤ ${kb(CSS_BUDGET_BYTES)})`,
  );
}

console.log("────────────────────────────────────────────────────────────\n");

if (failed) {
  process.exit(1);
}
