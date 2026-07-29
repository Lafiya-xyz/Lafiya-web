import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";

import "@testing-library/jest-dom/vitest";
import * as matchers from "vitest-axe/matchers";
import "vitest-axe/extend-expect";

// The real "server-only" package throws unconditionally unless the bundler
// sets the "react-server" resolve condition (how Next.js marks RSC builds).
// Vitest doesn't set that condition, so any module that imports
// lib/env-server.ts (which itself imports "server-only") would otherwise
// crash every test file that transitively reaches it.
vi.mock("server-only", () => ({}));

expect.extend(matchers);

// Vitest doesn't expose test globals by default, so RTL's own auto-cleanup
// (which detects a global afterEach) never registers without this.
afterEach(() => {
  cleanup();
});
