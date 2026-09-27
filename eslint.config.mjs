import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noWildcardPhiSelect from "./eslint-rules/no-wildcard-phi-select.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Issue #370: genuine logging needs go through lib/logging/logger.ts,
    // not a raw console call — a stray console.log/debug left over from a
    // debugging session won't be captured by whatever log
    // aggregation/monitoring the logger is wired up to. console.warn/error
    // are still allowed for legitimate low-level/startup diagnostics that
    // run before the logger itself is available.
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // The logger's own console.log call is the intended sink, not a leftover.
    files: ["lib/logging/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Issue #612: forbid wildcard selects on PHI-bearing Supabase tables.
    // The PHI table list is configurable and should be kept in sync with the
    // RoPA annotations.
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs}"],
    plugins: {
      local: {
        rules: {
          "no-wildcard-phi-select": noWildcardPhiSelect,
        },
      },
    },
    rules: {
      "local/no-wildcard-phi-select": [
        "error",
        {
          phiTables: ["profiles", "record_revisions", "profile_secrets"],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Raw browser assets: the offline service worker (public/sw.js) and its
    // shared helper (public/offline-cache-helpers.js) use Worker/DOM globals
    // and ES-module syntax that the Next TypeScript lint rules shouldn't
    // analyse. They are exercised by their own unit tests instead.
    "public/**",
  ]),
]);

export default eslintConfig;
