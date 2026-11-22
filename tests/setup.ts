import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";

import "@testing-library/jest-dom/vitest";
// Hermetic guards (Issue #956): unmocked network calls fail, time is frozen
// and `Math.random` is seeded by default. See tests/hermetic.ts for opt-outs.
import "./hermetic";
import * as matchers from "vitest-axe/matchers";
import "vitest-axe/extend-expect";

// The real "server-only" package throws unconditionally unless the bundler
// sets the "react-server" resolve condition (how Next.js marks RSC builds).
// Vitest doesn't set that condition, so any module that imports
// lib/env-server.ts (which itself imports "server-only") would otherwise
// crash every test file that transitively reaches it.
vi.mock("server-only", () => ({}));

// @sentry/nextjs's build-time webpack instrumentation detects "browser vs.
// Node" via `typeof document === 'undefined'`, which is false under jsdom —
// so importing it here resolves `document.baseURI` (an http: URL) where it
// expects a file: URL, and every transitive importer crashes at module load.
// Real Sentry calls are also unwanted noise in unit tests, so mock it globally.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn(
    (cb: (scope: { setExtras: (...args: unknown[]) => void }) => void) =>
      cb({ setExtras: vi.fn() }),
  ),
}));

expect.extend(matchers);

// Vitest doesn't expose test globals by default, so RTL's own auto-cleanup
// (which detects a global afterEach) never registers without this.
afterEach(() => {
  cleanup();
});
