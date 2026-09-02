// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Unit tests that validate the load-test harness files are internally
 * consistent — no database or running app required.
 *
 * These catch regressions like the original bugs:
 *   - seed script referencing a column name that doesn't exist
 *   - k6 script using a wrong URL path
 *   - k6 script referencing an undefined variable
 */
describe("load-test harness validation", () => {
  const seedSql = readFileSync(
    resolve(__dirname, "../supabase/seed_loadtest.sql"),
    "utf-8",
  );
  const k6Script = readFileSync(
    resolve(__dirname, "k6_get_emergency_card_test.js"),
    "utf-8",
  );

  describe("seed_loadtest.sql", () => {
    it("inserts into profiles using user_id, not id", () => {
      // The profiles table PK is user_id, not id.
      expect(seedSql).toContain("INSERT INTO public.profiles");
      expect(seedSql).toContain("user_id");

      // Must not use the old broken column name as the insert target.
      // We check that `(id,` or `( id,` does not appear as the first
      // column in any INSERT INTO public.profiles — but we allow `id`
      // in other contexts (e.g. auth.users has an `id` column).
      const profilesInsertMatch = seedSql.match(
        /INSERT INTO public\.profiles\s*\(([^)]+)\)/i,
      );
      expect(profilesInsertMatch).toBeTruthy();
      const firstColumn = profilesInsertMatch![1]
        .split(",")[0]
        .trim()
        .toLowerCase();
      expect(firstColumn).toBe("user_id");
    });

    it("creates auth.users rows before profiles (FK dependency)", () => {
      const authUsersPos = seedSql.indexOf("INSERT INTO auth.users");
      const profilesPos = seedSql.indexOf("INSERT INTO public.profiles");
      expect(authUsersPos).toBeGreaterThan(-1);
      expect(profilesPos).toBeGreaterThan(-1);
      expect(authUsersPos).toBeLessThan(profilesPos);
    });

    it("creates auth.identities rows (required for GoTrue)", () => {
      expect(seedSql).toContain("INSERT INTO auth.identities");
    });
  });

  describe("k6_get_emergency_card_test.js", () => {
    it("uses the correct URL path /card/ (not /public/card/)", () => {
      // (public) is a Next.js route group — excluded from the URL.
      expect(k6Script).not.toContain("/public/card/");
      expect(k6Script).toContain("/card/");
    });

    it("defines errorRate before using it", () => {
      // The original script used errorRate.add(1) without declaring it.
      expect(k6Script).toContain('new Rate("errors")');
    });

    it("imports Rate from k6/metrics", () => {
      expect(k6Script).toMatch(
        /import\s*\{[^}]*Rate[^}]*\}\s*from\s*["']k6\/metrics["']/,
      );
    });

    it("defines separate cache_hit and cache_miss scenarios", () => {
      expect(k6Script).toContain("cache_hit");
      expect(k6Script).toContain("cache_miss");
      expect(k6Script).toContain("cacheHitScenario");
      expect(k6Script).toContain("cacheMissScenario");
    });

    it("defines separate custom metrics for each scenario", () => {
      expect(k6Script).toContain("cache_hit_duration");
      expect(k6Script).toContain("cache_miss_duration");
      expect(k6Script).toContain("cache_hit_errors");
      expect(k6Script).toContain("cache_miss_errors");
    });

    it("reads card IDs from card_ids.txt", () => {
      expect(k6Script).toContain("card_ids.txt");
    });

    it("sets thresholds for both scenarios", () => {
      // Verify thresholds exist for both custom metrics.
      // Use [\s\S] instead of the `s` flag for ES5-compatible dotall.
      expect(k6Script).toMatch(/cache_hit_duration[\s\S]*p\(95\)/);
      expect(k6Script).toMatch(/cache_miss_duration[\s\S]*p\(95\)/);
    });
  });
});
