// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/profile/photo/route";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => {
  return {
    createClient: vi.fn(),
  };
});

// The route's per-user frequency cap (lib/frequency-limit.ts) is backed by
// Postgres in production (see
// supabase/migrations/20260729130000_frequency_limits_table.sql), the same
// way lib/rate-limit.ts is (see app/(auth)/signin/actions.test.ts for the
// precedent). These unit tests care about the route's own logic -- the
// dimension budget and how it reacts to the frequency cap -- not Postgres
// atomicity itself, so the admin client is faked here with a plain
// in-memory store implementing the same fixed-window increment contract as
// the real frequency_limit_check_and_increment() SQL function.
const { frequencyStore } = vi.hoisted(() => ({
  frequencyStore: new Map<string, { windowStart: number; count: number }>(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "frequency_limits") {
        throw new Error(`unexpected table in frequency-limit fake: ${table}`);
      }
      return {
        delete: () => ({
          eq: async (_column: string, key: string) => {
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
          throw new Error(`unexpected rpc in frequency-limit fake: ${fn}`);
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
          data: {
            allowed,
            count: record.count,
            retry_after_seconds: retryAfterSeconds,
          },
          error: null,
        };
      },
    }),
  }),
}));

function fixture(name: string): Buffer {
  return fs.readFileSync(path.resolve(__dirname, "fixtures", name));
}

function mockAuthedSupabase(userId: string) {
  const mockUpload = vi.fn().mockResolvedValue({ error: null });
  const mockGetPublicUrl = vi.fn().mockReturnValue({
    data: {
      publicUrl: `https://supabase.example.com/avatars/${userId}/photo.jpg`,
    },
  });

  const mockSupabase = {
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: userId } }, error: null }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: mockUpload,
        getPublicUrl: mockGetPublicUrl,
      }),
    },
  };
  vi.mocked(createClient).mockResolvedValue(
    mockSupabase as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  return { mockUpload, mockGetPublicUrl };
}

function uploadRequest(
  buffer: Buffer,
  type: string,
  filename: string,
): Request {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type }),
    filename,
  );
  return new Request("http://localhost/api/profile/photo", {
    method: "POST",
    body: formData,
  });
}

describe("Avatar Upload Route Handler", () => {
  const fixturePath = path.resolve(__dirname, "fixtures/gps-tagged.jpg");

  beforeEach(() => {
    frequencyStore.clear();
  });

  it("should reject unauthorized requests", async () => {
    const mockSupabase = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: null }, error: null }),
      },
    };
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase as unknown as Awaited<ReturnType<typeof createClient>>,
    );

    const request = uploadRequest(
      Buffer.from("fake-image"),
      "image/jpeg",
      "test.jpg",
    );

    const response = await POST(request);
    expect(response.status).toBe(401);

    const json = await response.json();
    expect(json.error).toBe("Unauthorized");
  });

  it("should strip EXIF/GPS metadata from uploaded image", async () => {
    // 1. Verify fixture exists and has EXIF metadata
    expect(fs.existsSync(fixturePath)).toBe(true);
    const fixtureBuffer = fs.readFileSync(fixturePath);
    const fixtureMetadata = await sharp(fixtureBuffer).metadata();
    expect(fixtureMetadata.exif).toBeDefined();

    // 2. Set up mocks
    const { mockUpload } = mockAuthedSupabase("test-user-123");

    // 3. Perform upload request
    const request = uploadRequest(
      fixtureBuffer,
      "image/jpeg",
      "gps-tagged.jpg",
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.publicUrl).toBe(
      "https://supabase.example.com/avatars/test-user-123/photo.jpg",
    );

    // 4. Assert direct-to-Storage upload arguments
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const uploadedPath = mockUpload.mock.calls[0][0];
    const uploadedBuffer = mockUpload.mock.calls[0][1] as Buffer;

    expect(uploadedPath).toBe("test-user-123/photo.jpg");

    // 5. Verify EXIF metadata has been stripped in the uploaded buffer
    const uploadedMetadata = await sharp(uploadedBuffer).metadata();
    expect(uploadedMetadata.exif).toBeUndefined();

    // 6. Verify image is resized to bounded dimensions (<= 800px)
    expect(uploadedMetadata.width).toBeLessThanOrEqual(800);
    expect(uploadedMetadata.height).toBeLessThanOrEqual(800);
  });

  describe("pre-decode dimension budget", () => {
    // Each fixture is a real, valid image whose header declares pixel
    // dimensions far beyond this route's ceiling (a solid-color raster
    // compresses to a tiny file regardless of how many pixels it declares),
    // proving the file-size check alone (MAX_BYTES) does nothing to stop a
    // decompression-bomb-style upload.
    const bombs: Array<{ file: string; type: string }> = [
      { file: "bomb-oversized.png", type: "image/png" },
      { file: "bomb-oversized.jpg", type: "image/jpeg" },
      { file: "bomb-oversized.webp", type: "image/webp" },
    ];

    for (const { file, type } of bombs) {
      it(`rejects an oversized ${type} (12000x12000, well under 5MB on disk) with 400`, async () => {
        const buffer = fixture(file);
        expect(buffer.length).toBeLessThan(5 * 1024 * 1024);

        mockAuthedSupabase("test-user-oversized");
        const request = uploadRequest(buffer, type, file);

        const response = await POST(request);
        expect(response.status).toBe(400);

        const json = await response.json();
        expect(json.error).toBe("Photo dimensions are too large to process.");
      });
    }

    it("rejects a 90-byte PNG whose header alone declares 40000x60000, in roughly constant time regardless of claimed size", async () => {
      // No real pixel payload backs this claim at all -- proving rejection
      // is driven purely by the cheap header read, not by anything that
      // scales with the declared (or actual) pixel count.
      const buffer = fixture("bomb-declared-only.png");
      expect(buffer.length).toBeLessThan(200);

      mockAuthedSupabase("test-user-declared-only");
      const request = uploadRequest(buffer, "image/png", "declared-only.png");

      const start = performance.now();
      const response = await POST(request);
      const elapsedMs = performance.now() - start;

      expect(response.status).toBe(400);
      // Generous bound for CI jitter -- the point is that this stays flat
      // no matter how large the declared dimensions are (40000x60000 here
      // vs. 12000x12000 real pixels in the fixtures above), unlike the
      // accept path, which must actually decode and resize every pixel.
      expect(elapsedMs).toBeLessThan(200);
    });

    it("rejects real oversized images no slower than a declared-only bomb -- proving the cost doesn't scale with declared/actual size", async () => {
      const timings: number[] = [];
      for (const { file, type } of [
        ...bombs,
        { file: "bomb-declared-only.png", type: "image/png" },
      ]) {
        mockAuthedSupabase(`test-user-timing-${file}`);
        const request = uploadRequest(fixture(file), type, file);

        const start = performance.now();
        const response = await POST(request);
        timings.push(performance.now() - start);
        expect(response.status).toBe(400);
      }

      // All rejections should land in the same cheap ballpark -- no
      // fixture's declared/actual pixel count (ranging from 144M to 2.4B)
      // should make rejection meaningfully slower than any other.
      const max = Math.max(...timings);
      const min = Math.min(...timings);
      expect(max - min).toBeLessThan(200);
    });

    it("rejects a PNG whose header lies about being small (10x10) while the real payload decodes to 12000x12000, without ever producing an oversized buffer", async () => {
      // Adversarial case: metadata() alone can be lied to here (the header
      // is self-consistent, just misdeclared), but PNG decoding is bounded
      // by the *declared* header size -- libspng errors out quickly instead
      // of continuing to process the mismatched real payload, so this
      // never turns into an expensive decode. The route must still surface
      // this as a clean, fast error rather than hanging or 500ing.
      const buffer = fixture("bomb-lied-header.png");

      mockAuthedSupabase("test-user-lied-header");
      const request = uploadRequest(buffer, "image/png", "lied-header.png");

      const start = performance.now();
      const response = await POST(request);
      const elapsedMs = performance.now() - start;

      expect([400, 500]).toContain(response.status);
      expect(elapsedMs).toBeLessThan(500);
    });
  });

  describe("per-user upload frequency cap", () => {
    it("allows uploads up to the configured budget and rejects the next one with 429", async () => {
      const { mockUpload } = mockAuthedSupabase("test-user-frequency");
      const fixtureBuffer = fs.readFileSync(fixturePath);

      // UPLOAD_FREQUENCY_MAX in route.ts is 5 per rolling 60s window.
      for (let i = 0; i < 5; i++) {
        const response = await POST(
          uploadRequest(fixtureBuffer, "image/jpeg", "gps-tagged.jpg"),
        );
        expect(response.status).toBe(200);
      }
      expect(mockUpload).toHaveBeenCalledTimes(5);

      const sixth = await POST(
        uploadRequest(fixtureBuffer, "image/jpeg", "gps-tagged.jpg"),
      );
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get("Retry-After")).toBeTruthy();
      const json = await sixth.json();
      expect(json.error).toMatch(/too many/i);

      // The 6th call must never have reached Storage.
      expect(mockUpload).toHaveBeenCalledTimes(5);
    });

    it("caps a burst of concurrent uploads from one account -- not all of them get processed", async () => {
      const { mockUpload } = mockAuthedSupabase("test-user-burst");
      const fixtureBuffer = fs.readFileSync(fixturePath);

      const N = 12;
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          POST(uploadRequest(fixtureBuffer, "image/jpeg", "gps-tagged.jpg")),
        ),
      );

      const okCount = responses.filter((r) => r.status === 200).length;
      const limitedCount = responses.filter((r) => r.status === 429).length;

      expect(okCount).toBe(5);
      expect(limitedCount).toBe(N - 5);
      expect(mockUpload).toHaveBeenCalledTimes(5);
    });

    it("keys the frequency cap per user -- a different account is unaffected", async () => {
      const fixtureBuffer = fs.readFileSync(fixturePath);

      mockAuthedSupabase("test-user-a");
      for (let i = 0; i < 5; i++) {
        const response = await POST(
          uploadRequest(fixtureBuffer, "image/jpeg", "gps-tagged.jpg"),
        );
        expect(response.status).toBe(200);
      }
      const blocked = await POST(
        uploadRequest(fixtureBuffer, "image/jpeg", "gps-tagged.jpg"),
      );
      expect(blocked.status).toBe(429);

      const { mockUpload: uploadB } = mockAuthedSupabase("test-user-b");
      const responseB = await POST(
        uploadRequest(fixtureBuffer, "image/jpeg", "gps-tagged.jpg"),
      );
      expect(responseB.status).toBe(200);
      expect(uploadB).toHaveBeenCalledTimes(1);
    });
  });
});
