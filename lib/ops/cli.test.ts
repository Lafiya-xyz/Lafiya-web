import { describe, expect, it, vi } from "vitest";

import {
  COMMANDS,
  renderDocs,
  runCommand,
  type AuditEvent,
  type RunDeps,
} from "./cli";

function fakeDeps() {
  const calls: string[] = [];
  const audits: AuditEvent[] = [];
  const logs: string[] = [];
  const deps: RunDeps = {
    authenticate: vi.fn(async () => ({ id: "operator-1" })),
    log: (line) => logs.push(line),
    db: {
      requeueOutbox: async (id) => void calls.push(`requeue:${id}`),
      resetRateLimit: async (key) => void calls.push(`reset:${key}`),
      setFlag: async (key, enabled) =>
        void calls.push(`flag:${key}:${enabled}`),
      audit: async (e) => void audits.push(e),
    },
  };
  return { deps, calls, audits, logs };
}

const ARGS: Record<string, string[]> = {
  "outbox:requeue": ["--id", "00000000-0000-0000-0000-000000000001"],
  "rate-limit:reset": ["--key", "attestation-lookup:203.0.113.7"],
  "flag:set": ["--key", "payouts", "--enabled", "false"],
};

describe("operator CLI", () => {
  for (const name of Object.keys(COMMANDS)) {
    it(`${name}: dry run prints the plan and touches nothing`, async () => {
      const { deps, calls, audits, logs } = fakeDeps();
      const code = await runCommand(
        [name, ...ARGS[name], "--reason", "ticket-1", "--env", "staging"],
        deps,
      );
      expect(code).toBe(0);
      expect(logs[0]).toMatch(/^\[dry-run\] Would /);
      expect(calls).toEqual([]);
      expect(audits).toEqual([]);
      expect(deps.authenticate).not.toHaveBeenCalled();
    });

    it(`${name}: --execute runs the action and writes an audit event`, async () => {
      const { deps, calls, audits } = fakeDeps();
      const code = await runCommand(
        [
          name,
          ...ARGS[name],
          "--reason",
          "ticket-1",
          "--env",
          "staging",
          "--execute",
        ],
        deps,
      );
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(audits).toEqual([
        expect.objectContaining({
          actor: "operator-1",
          command: name,
          reason: "ticket-1",
          environment: "staging",
        }),
      ]);
    });
  }

  it("requires --reason", async () => {
    const { deps, logs } = fakeDeps();
    expect(
      await runCommand(
        ["rate-limit:reset", "--key", "k", "--env", "staging"],
        deps,
      ),
    ).toBe(2);
    expect(logs[0]).toContain("--reason");
  });

  it("refuses production without --confirm-production", async () => {
    const { deps, calls } = fakeDeps();
    const argv = [
      "rate-limit:reset",
      "--key",
      "k",
      "--reason",
      "r",
      "--env",
      "production",
      "--execute",
    ];
    expect(await runCommand(argv, deps)).toBe(3);
    expect(calls).toEqual([]);
    expect(await runCommand([...argv, "--confirm-production"], deps)).toBe(0);
    expect(calls).toEqual(["reset:k"]);
  });

  it("does not act or audit when authentication fails", async () => {
    const { deps, calls, audits } = fakeDeps();
    deps.authenticate = async () => {
      throw new Error("Operator session must be MFA-verified (aal2)");
    };
    await expect(
      runCommand(
        [
          "rate-limit:reset",
          "--key",
          "k",
          "--reason",
          "r",
          "--env",
          "staging",
          "--execute",
        ],
        deps,
      ),
    ).rejects.toThrow("aal2");
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("generates docs for every command", () => {
    const docs = renderDocs();
    for (const name of Object.keys(COMMANDS))
      expect(docs).toContain(`## \`${name}\``);
  });
});
