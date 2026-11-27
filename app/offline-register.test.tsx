import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceWorkerRegister } from "./offline-register";

function mockServiceWorker() {
  const register = vi.fn().mockResolvedValue({} as ServiceWorkerRegistration);
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register },
    configurable: true,
  });
  return register;
}

function mockActiveWorker(version: string) {
  const postMessage = vi.fn();
  const worker = { postMessage } as unknown as ServiceWorker;
  const registration = {
    active: worker,
    waiting: null,
    installing: null,
    unregister: vi.fn().mockResolvedValue(true),
  } as unknown as ServiceWorkerRegistration;
  const register = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register },
    configurable: true,
  });
  return { register, registration, worker, postMessage, version };
}

describe("ServiceWorkerRegister", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the module service worker on load when supported", () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = mockServiceWorker();

    render(<ServiceWorkerRegister />);
    // jsdom may report readyState as "complete" (fires on mount) or still
    // loading (fires on the load event); dispatch it to cover both.
    window.dispatchEvent(new Event("load"));

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { type: "module" });
  });

  it("does nothing and does not throw when service workers are unsupported", () => {
    vi.stubEnv("NODE_ENV", "production");
    Object.defineProperty(navigator, "serviceWorker", {
      value: undefined,
      configurable: true,
    });

    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
  });

  it("skips registration while in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const register = mockServiceWorker();

    render(<ServiceWorkerRegister />);
    window.dispatchEvent(new Event("load"));

    expect(register).not.toHaveBeenCalled();
  });

  it("only ever registers the fixed /sw.js path", () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = mockServiceWorker();

    render(<ServiceWorkerRegister />);
    window.dispatchEvent(new Event("load"));

    expect(register).toHaveBeenCalledTimes(1);
    const [scriptURL] = register.mock.calls[0];
    expect(scriptURL).toBe("/sw.js");
  });

  it("reports a privacy-safe mismatch when the active worker version differs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SW_VERSION", "expected-hash");
    const { postMessage } = mockActiveWorker("unexpected-hash");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(<ServiceWorkerRegister />);
    window.dispatchEvent(new Event("load"));
    await Promise.resolve();
    await Promise.resolve();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SW_VERSION_QUERY" }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sw/mismatch",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    // Privacy-safe: only version hashes, no URLs, cookies or identifiers.
    expect(Object.keys(body).sort()).toEqual(["actual", "expected"]);
    expect(body.actual).toBe("unexpected-hash");
    expect(body.expected).toBe("expected-hash");
  });

  it("does not report when the active worker version matches", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SW_VERSION", "expected-hash");
    mockActiveWorker("expected-hash");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(<ServiceWorkerRegister />);
    window.dispatchEvent(new Event("load"));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalledWith(
      "/api/sw/mismatch",
      expect.anything(),
    );
  });

  it("kill switch posts SW_KILL_SWITCH, unregisters the worker and clears caches", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { registration, postMessage } = mockActiveWorker("expected-hash");
    const cacheDelete = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue(["card-cache-v1", "card-cache-v2"]),
      delete: cacheDelete,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(<ServiceWorkerRegister />);
    window.dispatchEvent(new Event("load"));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sw/kill-switch",
      expect.anything(),
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SW_KILL_SWITCH" }),
    );
    expect(registration.unregister).toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledWith("card-cache-v1");
    expect(cacheDelete).toHaveBeenCalledWith("card-cache-v2");
  });
});
