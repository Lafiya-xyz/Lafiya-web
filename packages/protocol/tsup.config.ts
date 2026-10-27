import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "schemas/index": "src/schemas/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // No server-only or secret-handling code in this package.
  // Explicitly disallow Node.js built-ins that would couple to a runtime.
  platform: "neutral",
  target: "es2020",
  splitting: false,
  treeshake: true,
});
