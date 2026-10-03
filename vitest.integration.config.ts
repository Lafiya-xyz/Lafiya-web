import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const envTestPath = path.resolve(__dirname, ".env.test");
if (fs.existsSync(envTestPath)) {
  process.loadEnvFile(envTestPath);
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    name: "integration",
    environment: "node",
    // Each worker gets its own cloned database (see
    // tests/integration/global-setup.ts), so the suite can run in parallel
    // without cross-worker interference.
    globalSetup: ["./tests/integration/global-setup.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    // Run at least 4 workers so the per-worker database isolation actually
    // buys us parallel wall-clock time.
    minWorkers: 4,
    maxWorkers: 4,
    // Real network calls to a local Supabase stack are slower than jsdom
    // unit tests; give them room rather than flaking under load.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
