import { describe, expect, it } from "vitest";

import {
  SHIFT_MAX_CARDS,
  SHIFT_MAX_MS,
  endShift,
  getShift,
  listVault,
  memoryVaultStore,
  openVaultEntry,
  startShift,
  vaultCard,
  wipeIfExpired,
} from "../../public/shift-vault.js";

const envelope = {
  version: 1,
  offlineAllowed: true,
  projection: { name: "A" },
};
const T0 = Date.UTC(2026, 10, 23, 8);

describe("responder shift vault (#873)", () => {
  it("uses a non-extractable key and decrypts entries during the shift", async () => {
    const store = memoryVaultStore();
    const shift = await startShift(store, { now: T0 });
    expect(shift.key.extractable).toBe(false);

    expect(await vaultCard(store, { path: "/card/x", envelope }, T0 + 1)).toBe(
      true,
    );
    const [item] = await listVault(store, T0 + 2);
    const opened = await openVaultEntry(store, item.id, T0 + 3);
    expect(opened).toEqual({ path: "/card/x", envelope });
  });

  it("destroys the key and entries when the shift ends", async () => {
    const store = memoryVaultStore();
    await startShift(store, { now: T0 });
    await vaultCard(store, { path: "/card/x", envelope }, T0 + 1);
    const [item] = await listVault(store, T0 + 2);

    await endShift(store);
    expect(await getShift(store)).toBeNull();
    expect(await listVault(store, T0 + 3)).toEqual([]);
    expect(await openVaultEntry(store, item.id, T0 + 3)).toBeNull();
  });

  it("wipes an expired shift on the next check (e.g. SW activation)", async () => {
    const store = memoryVaultStore();
    await startShift(store, { now: T0, durationMs: 60_000 });
    await vaultCard(store, { path: "/card/x", envelope }, T0 + 1);

    expect(await wipeIfExpired(store, T0 + 60_000)).toBe(true);
    expect(await getShift(store)).toBeNull();
    expect(await listVault(store, T0 + 60_001)).toEqual([]);
  });

  it("caps shift length at 12 hours", async () => {
    const store = memoryVaultStore();
    const shift = await startShift(store, {
      now: T0,
      durationMs: 48 * 3_600_000,
    });
    expect(shift.endsAt - shift.startedAt).toBe(SHIFT_MAX_MS);
  });

  it("caps the number of vaulted cards and de-duplicates rescans", async () => {
    const store = memoryVaultStore();
    await startShift(store, { now: T0 });
    for (let i = 0; i < SHIFT_MAX_CARDS; i++) {
      expect(
        await vaultCard(store, { path: `/card/${i}`, envelope }, T0 + i),
      ).toBe(true);
    }
    expect(
      await vaultCard(store, { path: "/card/extra", envelope }, T0 + 99),
    ).toBe(false);
    expect(
      await vaultCard(store, { path: "/card/0", envelope }, T0 + 100),
    ).toBe(true);
    expect(await listVault(store, T0 + 101)).toHaveLength(SHIFT_MAX_CARDS);
  });

  it("excludes cards without offline consent and scans outside a shift", async () => {
    const store = memoryVaultStore();
    expect(await vaultCard(store, { path: "/card/x", envelope }, T0)).toBe(
      false,
    );
    await startShift(store, { now: T0 });
    expect(
      await vaultCard(store, { path: "/card/x", envelope: null }, T0 + 1),
    ).toBe(false);
    expect(
      await vaultCard(
        store,
        { path: "/card/y", envelope: { ...envelope, offlineAllowed: false } },
        T0 + 1,
      ),
    ).toBe(false);
    expect(await listVault(store, T0 + 2)).toEqual([]);
  });
});
