import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    // Issue #601: all date/number/phone formatting must be routed through
    // lib/format so locale fallback chains and ICU-missing handling stay in
    // one place. Direct toLocaleString/Intl calls outside lib/format are
    // forbidden — a US-style MM/DD date on an emergency card can be
    // misread dangerously.
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    ignores: ["lib/format/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='toLocaleString']",
          message:
            "Use lib/format helpers instead of toLocaleString (issue #601).",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            "Use lib/format helpers instead of toLocaleDateString (issue #601).",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleTimeString']",
          message:
            "Use lib/format helpers instead of toLocaleTimeString (issue #601).",
        },
        {
          selector: "NewExpression[callee.name='Intl']",
          message:
            "Use lib/format helpers instead of direct Intl calls (issue #601).",
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
