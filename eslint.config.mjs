import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
    // Supabase CLI runtime bundles are generated under this directory when a
    // local stack is started; they are not project source.
    "supabase/.temp/**",
  ]),
]);

export default eslintConfig;
