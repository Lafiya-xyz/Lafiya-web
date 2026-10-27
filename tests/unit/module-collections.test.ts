// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Issue #785: every module-level (or class-field) Map/Set in server code
 * lives for the lifetime of a warm instance, so each must have a documented
 * bound. Adding a new one fails this test until it is listed here with its
 * bound; removing one fails until its stale entry is deleted.
 */
const DOCUMENTED_BOUNDS: Record<string, string> = {
  "app/(auth)/signup/actions.ts:EXISTENCE_DEPENDENT_CODES":
    "constant literal set",
  "app/api/chw/sponsor/route.ts:quotaLedger": "BoundedMap(10_000)",
  "app/api/e/route.ts:ALLOWED_EVENTS": "constant literal set",
  "app/api/e/route.ts:ALLOWED_PROPS": "constant literal set",
  "app/api/e/route.ts:rateBuckets": "BoundedMap(10_000)",
  "app/api/vitals/route.ts:aggregationStore":
    "BoundedMap(256), samples capped at 1_000 per bucket",
  "app/api/vitals/route.ts:rateLimitStore":
    "BoundedMap(10_000), timestamps pruned to the window",
  "lib/flags.ts:cache": "keyed by the finite FlagKey union, 30s TTL",
  "lib/logging/logger.ts:SENSITIVE_KEYS": "constant literal set",
  "lib/notifications/dispatch.ts:CRITICAL_EVENTS": "constant literal set",
  "lib/notifications/dispatch.ts:DEVICE_FAMILIES": "constant literal set",
  "lib/notifications/templates.ts:PHI_BLOCKLIST": "constant literal set",
  "lib/observability/sentry-sanitize.ts:SAFE_KEYS": "constant literal set",
  "lib/outbox/dispatcher.ts:HANDLERS": "constant handler registry",
  "lib/runtime-config.ts:ALLOWLISTED_DEPLOYMENTS": "constant literal set",
  "lib/security/breached-password.ts:prefixCache":
    "LRU capped at CACHE_MAX_ENTRIES (64)",
  "lib/sessions/throttle.ts:lastTouched":
    "per-throttle LRU capped at maxEntries",
  "lib/stellar/attestation.ts:MOCK_ATTESTATIONS": "constant mock fixtures",
  "lib/stellar/payout-indexer/sources.ts:trustlineCache":
    "BoundedMap(10_000), 5 minute TTL",
  "lib/stellar/sponsor-policy.ts:counts": "BoundedMap(10_000)",
};

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "lib"];
// Module-level declarations, class fields, and the factory-closure store in
// lib/sessions/throttle.ts (one level of indentation inside an exported
// factory that outlives the call).
const DECLARATION =
  /^(?:export\s+)?(?:const|let)\s+(\w+)\b[^=]*=\s*new\s+(?:Bounded)?(?:Map|Set)\b|^\s+(?:(?:private|protected|public|readonly|static)\s+)+(\w+)\b[^=]*=\s*new\s+(?:Bounded)?(?:Map|Set)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) &&
      !/\.(test|stories)\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

function findCollections(): string[] {
  const found: string[] = [];
  for (const file of SCAN_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))) {
    const rel = relative(ROOT, file).split("\\").join("/");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = DECLARATION.exec(line);
      if (match) found.push(`${rel}:${match[1] ?? match[2]}`);
    }
  }
  if (
    readFileSync(join(ROOT, "lib/sessions/throttle.ts"), "utf8").includes(
      "const lastTouched = new Map",
    )
  ) {
    found.push("lib/sessions/throttle.ts:lastTouched");
  }
  return [...new Set(found)].sort();
}

describe("module-level collection bounds", () => {
  it("documents a bound for every long-lived Map/Set", () => {
    const undocumented = findCollections().filter(
      (key) => !(key in DOCUMENTED_BOUNDS),
    );
    expect(undocumented).toEqual([]);
  });

  it("has no stale inventory entries", () => {
    const found = new Set(findCollections());
    expect(
      Object.keys(DOCUMENTED_BOUNDS).filter((key) => !found.has(key)),
    ).toEqual([]);
  });
});
