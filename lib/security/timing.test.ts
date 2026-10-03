import { describe, expect, it, vi } from "vitest";

import { withTimingFloor } from "./timing";

function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("withTimingFloor", () => {
  it("pads a fast operation up to the floor", async () => {
    const { clock, advance } = fakeClock();
    const sleep = vi.fn(async (ms: number) => advance(ms));

    const result = await withTimingFloor(
      1000,
      async () => {
        advance(120);
        return "done";
      },
      clock,
      sleep,
    );

    expect(result).toBe("done");
    expect(sleep).toHaveBeenCalledWith(880);
    expect(clock()).toBe(1000);
  });

  it("pads before rethrowing, so a thrown redirect takes as long as a returned error", async () => {
    const { clock, advance } = fakeClock();
    const sleep = vi.fn(async (ms: number) => advance(ms));
    const redirect = new Error("NEXT_REDIRECT");

    await expect(
      withTimingFloor(
        1000,
        async () => {
          advance(300);
          throw redirect;
        },
        clock,
        sleep,
      ),
    ).rejects.toBe(redirect);
    expect(sleep).toHaveBeenCalledWith(700);
    expect(clock()).toBe(1000);
  });

  it("adds nothing when the operation already exceeded the floor", async () => {
    const { clock, advance } = fakeClock();
    const sleep = vi.fn(async (ms: number) => advance(ms));

    await withTimingFloor(
      1000,
      async () => {
        advance(1500);
      },
      clock,
      sleep,
    );

    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives fast and slow paths the same observed duration", async () => {
    const durations: number[] = [];
    for (const work of [5, 90, 400, 999]) {
      const { clock, advance } = fakeClock();
      await withTimingFloor(
        1000,
        async () => advance(work),
        clock,
        async (ms) => advance(ms),
      );
      durations.push(clock());
    }
    expect(new Set(durations)).toEqual(new Set([1000]));
  });

  it("uses real time by default", async () => {
    const started = performance.now();
    await withTimingFloor(40, async () => undefined);
    expect(performance.now() - started).toBeGreaterThanOrEqual(39);
  });
});
