import path from "node:path";
import { defineConfig } from "vitest/config";

// Long-running soak scenario (issue #785). Not part of `npm test`; run with
// `npm run test:soak` (SOAK_DURATION_MS controls the length).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    name: "soak",
    environment: "node",
    include: ["loadtest/**/*.soak.ts"],
    testTimeout: 2 * 60 * 60 * 1000,
  },
});
