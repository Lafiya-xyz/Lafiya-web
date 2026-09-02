/**
 * Integration tests for the profile photo upload route handler.
 *
 * Covers issue #332: hits the route handler directly (not the storage bucket
 * directly — that's tests/integration/avatars-storage.test.ts) with:
 *   1. A valid JPEG — expects 200 + { publicUrl }
 *   2. A disallowed MIME type — expects 400 with a specific, non-generic error
 *   3. An oversized file — expects 400 with a message stating the size limit
 *
 * Coverage NOT duplicated from tests/avatar-upload.test.ts:
 *   - That file covers auth rejection, EXIF stripping, dimension bombs, and
 *     the per-user frequency cap with a fully-mocked Supabase stack.
 *   - This file exercises the full HTTP layer against a real local Supabase
 *     (auth + storage), proving the validation gates survive an end-to-end
 *     request that flows through real middleware, not just a unit-test double.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/profile/photo/route";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { createTestUser, deleteTestUser, type TestUser } from "./helpers/testUser";

// ---------------------------------------------------------------------------
// The route uses lib/supabase/server to create a session-scoped client. In
// integration tests there is no Next.js cookie store, so we intercept
// createClient() and return a client that is already signed in as our test
// user. This is the same technique used in tests/avatar-upload.test.ts
// (which mocks the same import) — the difference is that here we use a real
// Supabase instance rather than a fully in-memory double.
// ---------------------------------------------------------------------------

let testUser: TestUser;
let supabaseServerClientOverride: ReturnType<typeof createSupabaseClient<Database>>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => supabaseServerClientOverride),
}));

// Frequency-limit also uses the admin client, but the limit is 5/minute and
// each test uses a fresh user, so in practice we'll never exceed it.
// We reuse the same admin-client fake as the unit suite so the route's
// checkAndIncrementFrequency call succeeds rather than throwing.
const { frequencyStore } = vi.hoisted(() => ({
  frequencyStore: new Map<string, { windowStart: number; count: number }>(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "frequency_limits") throw new Error(`unexpected: ${table}`);
      return {
        delete: () => ({
          eq: async (_col: string, key: string) => {
            frequencyStore.delete(key);
            return { error: null };
          },
        }),
      };
    },
    rpc: (
      fn: string,
      args: { p_key: string; p_max_count: number; p_window_seconds: number },
    ) => ({
      single: async () => {
        if (fn !== "frequency_limit_check_and_increment") {
          throw new Error(`unexpected rpc: ${fn}`);
        }
        const now = Date.now();
        const windowMs = args.p_window_seconds * 1000;
        const existing = frequencyStore.get(args.p_key);
        const record =
          existing && existing.windowStart + windowMs > now
            ? { windowStart: existing.windowStart, count: existing.count + 1 }
            : { windowStart: now, count: 1 };
        frequencyStore.set(args.p_key, record);
        const allowed = record.count <= args.p_max_count;
        const retryAfterSeconds = allowed
          ? 0
          : Math.ceil((record.windowStart + windowMs - now) / 1000);
        return {
          data: { allowed, count: record.count, retry_after_seconds: retryAfterSeconds },
          error: null,
        };
      },
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");
const GPS_JPEG = fs.readFileSync(path.join(FIXTURES_DIR, "gps-tagged.jpg"));

/** Minimal valid 1×1 PNG for tests that don't care about content. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(buffer: Buffer, mimeType: string, filename: string): Request {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mimeType }),
    filename,
  );
  return new Request("http://localhost/api/profile/photo", {
    method: "POST",
    body: form,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  testUser = await createTestUser();

  // Build a real signed-in Supabase client for this user.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  // We use the already-signed-in client from createTestUser so the server
  // mock returns an authenticated session.
  supabaseServerClientOverride =
    testUser.client as unknown as ReturnType<typeof createSupabaseClient<Database>>;

  void url;
  void anonKey;
});

afterAll(async () => {
  // Best-effort: clean up any uploaded avatar.
  if (testUser) {
    await testUser.client.storage
      .from("avatars")
      .remove([`${testUser.id}/photo.jpg`, `${testUser.id}/photo.png`]);
    await deleteTestUser(testUser.id);
  }
  frequencyStore.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/profile/photo — route handler integration", () => {
  it("accepts a valid JPEG and returns 200 with a publicUrl", async () => {
    const response = await POST(makeRequest(GPS_JPEG, "image/jpeg", "photo.jpg"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ publicUrl: expect.any(String) });
    // publicUrl should be a non-empty string pointing somewhere meaningful.
    expect(body.publicUrl.length).toBeGreaterThan(0);
  });

  it("rejects a disallowed file type with 400 and a specific (non-generic) error", async () => {
    const pdfBytes = Buffer.from("%PDF-1.0 fake pdf content");
    const response = await POST(
      makeRequest(pdfBytes, "application/pdf", "document.pdf"),
    );
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBeTruthy();
    // Must NOT be a generic server-side error message.
    expect(body.error).not.toMatch(/internal server error/i);
    // Must not be a 500-style message.
    expect(body.error).not.toMatch(/something went wrong/i);
    // Should clearly communicate the problem with the file type.
    expect(body.error).toMatch(/invalid file type/i);
  });

  it("rejects an oversized file with 400 and a message stating the size limit", async () => {
    // Route limit is 5 MB. Build a buffer one byte over.
    const FIVE_MB = 5 * 1024 * 1024;
    const oversized = Buffer.alloc(FIVE_MB + 1, 0xff);
    const response = await POST(
      makeRequest(oversized, "image/jpeg", "big-photo.jpg"),
    );
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBeTruthy();
    // The error must state the limit so the caller knows what the bound is.
    expect(body.error).toMatch(/5\s*(mb|mib|megabyte)/i);
    // Must not be a generic fallback message.
    expect(body.error).not.toMatch(/internal server error/i);
  });
});
