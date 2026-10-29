import { describe, expect, it } from "vitest";

import { Singleflight } from "./singleflight";

describe("Singleflight (Issue #692)", () => {
  it("coalesces 100 concurrent lookups for one key into one upstream call", async () => {
    const flight = new Singleflight({ maxKeys: 10, ttlMs: 1000 });
    let calls = 0;
    let release!: (value: string) => void;
    const upstream = () => {
      calls++;
      return new Promise<string>((resolve) => (release = resolve));
    };

    const results = Array.from({ length: 100 }, () =>
      flight.do<string>("commitment", upstream),
    );
    await Promise.resolve();
    release("attested");

    expect(await Promise.all(results)).toEqual(Array(100).fill("attested"));
    expect(calls).toBe(1);
    expect(flight.metrics).toEqual({ originated: 1, coalesced: 99 });
  });

  it("propagates a leader rejection to followers without poisoning later calls", async () => {
    const flight = new Singleflight({ maxKeys: 10, ttlMs: 1000 });
    const failing = (): Promise<string> =>
      Promise.reject(new Error("rate limited"));

    const leader = flight.do("k", failing);
    const follower = flight.do("k", failing);
    await expect(leader).rejects.toThrow("rate limited");
    await expect(follower).rejects.toThrow("rate limited");

    await expect(flight.do("k", async () => "ok")).resolves.toBe("ok");
    expect(flight.size).toBe(0);
  });

  it("stays bounded under 100k distinct keys", () => {
    const flight = new Singleflight({ maxKeys: 1000, ttlMs: 1000 });
    for (let i = 0; i < 100_000; i++) {
      void flight.do(`key-${i}`, () => new Promise<void>(() => {}));
    }
    expect(flight.size).toBeLessThanOrEqual(1000);
  });
});
