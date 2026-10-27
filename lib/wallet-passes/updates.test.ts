import { describe, expect, it, vi } from "vitest";

import {
  handlePassKitRequest,
  passAuthToken,
  PassUpdateDeferredError,
  processCardChanged,
  voidPasses,
  type PassKitRequest,
  type PassRecord,
  type PassRegistrationStore,
} from "./updates";

const SERIAL = "a".repeat(64);
const TYPE = "pass.xyz.lafiya.emergency";
const SECRET = "secret";
const AUTH = `ApplePass ${passAuthToken(SERIAL, SECRET)}`;
const PUSH = "ab".repeat(32);

function memoryStore() {
  const passes = new Map<string, PassRecord>();
  const regs = new Map<
    string,
    { device: string; serial: string; pushToken: string }
  >();
  const store: PassRegistrationStore = {
    async register(device, pushToken, serial) {
      const key = `${device}/${serial}`;
      const created = !regs.has(key);
      regs.set(key, { device, serial, pushToken });
      return created;
    },
    async unregister(device, serial) {
      return regs.delete(`${device}/${serial}`);
    },
    async serialsForDevice(device, since) {
      return [...regs.values()]
        .filter((r) => r.device === device)
        .map((r) => passes.get(r.serial)!)
        .filter((p) => since === null || p.updatedAt > since);
    },
    async getPass(serial) {
      return passes.get(serial) ?? null;
    },
    async pushTokens(serial) {
      return [...regs.values()]
        .filter((r) => r.serial === serial)
        .map((r) => r.pushToken);
    },
    async markUpdated(serial, now, opts) {
      const p = passes.get(serial)!;
      p.updatedAt = now;
      if (opts?.voided) p.voided = true;
    },
    async recordPush(serial, now) {
      passes.get(serial)!.lastPushAt = now;
    },
    async removeRegistrations(serial) {
      for (const [k, r] of regs) if (r.serial === serial) regs.delete(k);
    },
  };
  passes.set(SERIAL, {
    serial: SERIAL,
    updatedAt: 1_000_000,
    lastPushAt: null,
    voided: false,
    capabilityUrl: "https://lafiya.xyz/card/c/x",
  });
  return { store, passes, regs };
}

function req(
  method: string,
  path: string,
  extra: Partial<PassKitRequest> = {},
): PassKitRequest {
  return {
    method,
    path: path.split("/").filter(Boolean),
    authorization: AUTH,
    ifModifiedSince: null,
    query: new URLSearchParams(),
    body: null,
    ...extra,
  };
}

function deps(store: PassRegistrationStore) {
  return {
    store,
    passTypeIdentifier: TYPE,
    authSecret: SECRET,
    renderPass: vi.fn(async (p: PassRecord) =>
      Buffer.from(JSON.stringify({ voided: p.voided })),
    ),
  };
}

/**
 * PassKit web-service contract checklist (docs/wallet-passes.md):
 * 1. register → 201 new / 200 existing; 401 bad auth; 400 missing pushToken
 * 2. list serials → 200 {serialNumbers,lastUpdated}; 204 when none since tag
 * 3. fetch pass → 200 pkpass + Last-Modified; 304 if not modified; 401 bad auth
 * 4. unregister → 200
 * 5. log → 200
 */
describe("PassKit web service contract", () => {
  const regPath = `devices/dev1/registrations/${TYPE}/${SERIAL}`;

  it("registers, lists, fetches and unregisters", async () => {
    const { store } = memoryStore();
    const d = deps(store);

    expect(
      (
        await handlePassKitRequest(
          req("POST", regPath, { body: { pushToken: PUSH } }),
          d,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await handlePassKitRequest(
          req("POST", regPath, { body: { pushToken: PUSH } }),
          d,
        )
      ).status,
    ).toBe(200);

    const list = await handlePassKitRequest(
      req("GET", `devices/dev1/registrations/${TYPE}`),
      d,
    );
    expect(list).toEqual({
      status: 200,
      json: { serialNumbers: [SERIAL], lastUpdated: "1000000" },
    });
    const none = await handlePassKitRequest(
      req("GET", `devices/dev1/registrations/${TYPE}`, {
        query: new URLSearchParams({ passesUpdatedSince: "1000000" }),
      }),
      d,
    );
    expect(none.status).toBe(204);

    const pass = await handlePassKitRequest(
      req("GET", `passes/${TYPE}/${SERIAL}`),
      d,
    );
    expect(pass.status).toBe(200);
    expect(pass.pkpass).toBeInstanceOf(Buffer);
    const cached = await handlePassKitRequest(
      req("GET", `passes/${TYPE}/${SERIAL}`, {
        ifModifiedSince: pass.lastModified!,
      }),
      d,
    );
    expect(cached.status).toBe(304);

    expect((await handlePassKitRequest(req("DELETE", regPath), d)).status).toBe(
      200,
    );
    expect(
      (
        await handlePassKitRequest(
          req("POST", "log", { body: { logs: [] } }),
          d,
        )
      ).status,
    ).toBe(200);
  });

  it("rejects bad auth, bad bodies and unknown pass types", async () => {
    const d = deps(memoryStore().store);
    const bad = { authorization: "ApplePass " + "0".repeat(64) };
    expect(
      (
        await handlePassKitRequest(
          req("POST", regPath, { ...bad, body: { pushToken: PUSH } }),
          d,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handlePassKitRequest(
          req("GET", `passes/${TYPE}/${SERIAL}`, bad),
          d,
        )
      ).status,
    ).toBe(401);
    expect(
      (await handlePassKitRequest(req("POST", regPath, { body: {} }), d))
        .status,
    ).toBe(400);
    expect(
      (await handlePassKitRequest(req("GET", `passes/other/${SERIAL}`), d))
        .status,
    ).toBe(404);
  });
});

describe("processCardChanged coalescing", () => {
  it("sends at most one push per window and defers the rest", async () => {
    const { store, regs } = memoryStore();
    regs.set("dev1/x", { device: "dev1", serial: SERIAL, pushToken: PUSH });
    const pusher = { push: vi.fn(async () => {}) };
    let now = 2_000_000;
    const d = { store, pusher, clock: () => now, windowMs: 60_000 };

    expect(await processCardChanged(SERIAL, d)).toBe("pushed");
    now += 1_000;
    await expect(processCardChanged(SERIAL, d)).rejects.toBeInstanceOf(
      PassUpdateDeferredError,
    );
    now += 10_000;
    await expect(processCardChanged(SERIAL, d)).rejects.toBeInstanceOf(
      PassUpdateDeferredError,
    );
    expect(pusher.push).toHaveBeenCalledTimes(1);

    now = 2_000_000 + 60_000;
    expect(await processCardChanged(SERIAL, d)).toBe("pushed");
    expect(pusher.push).toHaveBeenCalledTimes(2);
  });
});

describe("voidPasses", () => {
  it("voids, pushes and removes registrations", async () => {
    const { store, passes, regs } = memoryStore();
    regs.set("dev1/x", { device: "dev1", serial: SERIAL, pushToken: PUSH });
    const pusher = { push: vi.fn(async () => {}) };
    await voidPasses([SERIAL], { store, pusher, clock: () => 3_000_000 });

    expect(pusher.push).toHaveBeenCalledWith([PUSH]);
    expect(regs.size).toBe(0);
    expect(passes.get(SERIAL)).toMatchObject({ voided: true });

    const d = deps(store);
    const res = await handlePassKitRequest(
      req("GET", `passes/${TYPE}/${SERIAL}`),
      d,
    );
    expect(res.status).toBe(200);
    expect(d.renderPass).toHaveBeenCalledWith(
      expect.objectContaining({ voided: true }),
    );
  });
});
