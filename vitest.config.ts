import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    name: "unit",
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/tests/integration/**"],
    clearMocks: true,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      SUPABASE_SERVICE_ROLE_KEY:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["lib/**/*.{ts,tsx}"],
      exclude: [
        "**/node_modules/**",
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "lib/**/index.ts",
      ],
      thresholds: {
        "lib/emergency/**": {
          lines: 90,
          branches: 90,
        },
        "lib/attestation/**": {
          lines: 90,
          branches: 90,
        },
        "lib/chw-protocol/**": {
          lines: 90,
          branches: 90,
        },
        "lib/stellar/**": {
          lines: 90,
          branches: 90,
        },
      },
    },
  },
});
