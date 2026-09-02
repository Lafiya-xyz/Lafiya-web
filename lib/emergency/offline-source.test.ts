import { describe, expect, it, vi } from "vitest";

import { resolveEmergencyCardSource } from "./offline-source";

describe("resolveEmergencyCardSource", () => {
  it("uses live data when the network is fully online and responds quickly", async () => {
    const fetchLive = vi.fn().mockResolvedValue({ recordUpdatedAt: "live" });
    const readCache = vi.fn().mockResolvedValue({ recordUpdatedAt: "cached" });

    const result = await resolveEmergencyCardSource(
      fetchLive,
      readCache,
      3000,
    );

    expect(result.source).toBe("live");
    expect(result.data).toEqual({ recordUpdatedAt: "live" });
    expect(readCache).not.toHaveBeenCalled();
  });

  it("falls back to cached data when fully offline", async () => {
    const fetchLive = vi.fn().mockRejectedValue(new Error("NETWORK_ERROR"));
    const readCache = vi.fn().mockResolvedValue({ recordUpdatedAt: "cached" });

    const result = await resolveEmergencyCardSource(
      fetchLive,
      readCache,
      3000,
    );

    expect(result.source).toBe("cache");
    expect(result.data).toEqual({ recordUpdatedAt: "cached" });
    expect(readCache).toHaveBeenCalledTimes(1);
  });

  it("falls back to cached data instead of hanging when a slow connection times out", async () => {
    vi.useFakeTimers();
    try {
      const fetchLive = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ recordUpdatedAt: "very-late" }), 60000);
          }),
      );
      const readCache = vi
        .fn()
        .mockResolvedValue({ recordUpdatedAt: "cached" });

      const pending = resolveEmergencyCardSource(fetchLive, readCache, 3000);

      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;

      expect(result.source).toBe("cache");
      expect(result.data).toEqual({ recordUpdatedAt: "cached" });
      expect(readCache).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
