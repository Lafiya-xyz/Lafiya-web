import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@lafiya/protocol",
    environment: "node",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
  },
});
