import { describe, expect, it } from "vitest";

import { ContractGovernanceMonitor } from "./governance-monitor";
import type {
  ContractAdminEvent,
  ContractAdminEventSource,
  ContractGovernanceStore,
  ContractTrustStatus,
  OperatorAlert,
  OperatorAlerter,
} from "./types";

const APPROVED = "a".repeat(64);
const UNKNOWN = "f".repeat(64);

const base = {
  contractId: "CEXAMPLE",
  ledgerSequence: 100,
  transactionHash: "tx-1",
  observedAt: "2026-09-26T00:00:00.000Z",
};

const upgrade = (eventId: string, wasmHash?: string): ContractAdminEvent => ({
  ...base,
  eventId,
  kind: "wasm_upgrade",
  ...(wasmHash ? { wasmHash } : {}),
});

class Store implements ContractGovernanceStore {
  cursor: string | null = null;
  trust: ContractTrustStatus | null = null;
  events = new Map<string, ContractAdminEvent>();

  async getCursor() {
    return this.cursor;
  }
  async getTrustStatus() {
    return this.trust;
  }
  async recordAdminEvent(event: ContractAdminEvent) {
    this.events.set(event.eventId, event);
  }
  async setTrustStatus(status: ContractTrustStatus) {
    this.trust = status;
  }
  async saveCursor(cursor: string) {
    this.cursor = cursor;
  }
}

class Source implements ContractAdminEventSource {
  constructor(private readonly events: ContractAdminEvent[]) {}
  async read() {
    return { events: this.events, cursor: "cursor-1" };
  }
}

class Alerter implements OperatorAlerter {
  alerts: OperatorAlert[] = [];
  async alert(alert: OperatorAlert) {
    this.alerts.push(alert);
  }
}

function run(
  store: Store,
  events: ContractAdminEvent[],
  alerter = new Alerter(),
) {
  return new ContractGovernanceMonitor(
    store,
    new Source(events),
    [APPROVED],
    alerter,
  ).runOnce();
}

describe("ContractGovernanceMonitor", () => {
  it("degrades trust and alerts operators on an unknown WASM hash", async () => {
    const store = new Store();
    const alerter = new Alerter();
    const result = await run(store, [upgrade("up-1", UNKNOWN)], alerter);

    expect(result.trust).toEqual({
      state: "needs_review",
      wasmHash: UNKNOWN,
      reasonCode: "UNAPPROVED_WASM_HASH",
    });
    expect(store.trust?.state).toBe("needs_review");
    expect(alerter.alerts).toEqual([
      {
        code: "UNAPPROVED_WASM_HASH",
        contractId: "CEXAMPLE",
        eventId: "up-1",
        wasmHash: UNKNOWN,
      },
    ]);
    expect(store.cursor).toBe("cursor-1");
  });

  it("treats an upgrade without a readable hash as unapproved", async () => {
    const store = new Store();
    const result = await run(store, [upgrade("up-1")]);
    expect(result.trust.state).toBe("needs_review");
    // Stays degraded on the next run with no new events.
    expect((await run(store, [])).trust.state).toBe("needs_review");
  });

  it("trusts an approved upgrade without alerting", async () => {
    const store = new Store();
    const alerter = new Alerter();
    const result = await run(
      store,
      [upgrade("up-1", APPROVED.toUpperCase())],
      alerter,
    );
    expect(result.trust).toEqual({
      state: "trusted",
      wasmHash: APPROVED,
      reasonCode: null,
    });
    expect(alerter.alerts).toEqual([]);
  });

  it("restores trust once an operator approves the observed hash", async () => {
    const store = new Store();
    await run(store, [upgrade("up-1", UNKNOWN)]);
    const approved = await new ContractGovernanceMonitor(
      store,
      new Source([]),
      [APPROVED, UNKNOWN],
      new Alerter(),
    ).runOnce();
    expect(approved.trust.state).toBe("trusted");
  });

  it("indexes allowlist changes and admin transfers and alerts on them", async () => {
    const store = new Store();
    const alerter = new Alerter();
    const events: ContractAdminEvent[] = [
      {
        ...base,
        eventId: "allow-1",
        kind: "allowlist_change",
        subject: "GATTESTER",
        action: "added",
      },
      { ...base, eventId: "admin-1", kind: "admin_transfer", subject: "GNEW" },
    ];
    const result = await run(store, events, alerter);

    expect(result.recorded).toBe(2);
    expect(store.events.get("allow-1")).toMatchObject({
      kind: "allowlist_change",
      subject: "GATTESTER",
      action: "added",
    });
    expect(alerter.alerts.map((alert) => alert.code)).toEqual([
      "ALLOWLIST_CHANGED",
      "ADMIN_TRANSFERRED",
    ]);
    expect(result.trust.state).toBe("trusted");
  });

  it("marks a paused contract and clears it on unpause", async () => {
    const store = new Store();
    expect(
      (await run(store, [{ ...base, eventId: "p-1", kind: "pause" }])).trust
        .state,
    ).toBe("paused");
    expect(
      (await run(store, [{ ...base, eventId: "u-1", kind: "unpause" }])).trust
        .state,
    ).toBe("trusted");
  });

  it("does not advance the cursor when recording fails", async () => {
    const store = new Store();
    store.recordAdminEvent = async () => {
      throw new Error("database unavailable");
    };
    await expect(run(store, [upgrade("up-1", UNKNOWN)])).rejects.toThrow(
      "database unavailable",
    );
    expect(store.cursor).toBeNull();
  });
});
