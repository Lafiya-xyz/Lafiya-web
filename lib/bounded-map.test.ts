import { describe, expect, it } from "vitest";

import { BoundedMap } from "./bounded-map";

describe("BoundedMap", () => {
  it("never exceeds maxEntries and evicts the oldest key", () => {
    const map = new BoundedMap<number, number>(3);
    for (let i = 0; i < 100; i++) map.set(i, i);
    expect(map.size).toBe(3);
    expect([...map.keys()]).toEqual([97, 98, 99]);
  });

  it("refreshes a re-set key so it is evicted last", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1).set("b", 2).set("a", 3).set("c", 4);
    expect([...map.entries()]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
  });

  it("rejects a non-positive bound", () => {
    expect(() => new BoundedMap(0)).toThrow(RangeError);
  });
});
