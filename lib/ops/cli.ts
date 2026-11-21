/**
 * Operator CLI for common production tasks (issue #787).
 *
 *   node lib/ops/cli.ts <command> [--flags] --reason "..." --env <name>
 *       [--execute] [--confirm-production]
 *   node lib/ops/cli.ts docs        # print Markdown docs for every command
 *
 * Safety model:
 *  - Every command defaults to a dry run; `--execute` is required to act.
 *  - `--reason` is mandatory and recorded with the actor in
 *    `public.operator_audit_log` for every executed action.
 *  - `--env production` refuses to execute without `--confirm-production`.
 *  - The operator authenticates with their own Supabase session token
 *    (LAFIYA_OPERATOR_ACCESS_TOKEN), which must carry the `admin` role and an
 *    MFA (aal2) assurance level -- never a shared secret.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface Operator {
  id: string;
}

export interface OpsDb {
  requeueOutbox(id: string): Promise<void>;
  resetRateLimit(key: string): Promise<void>;
  setFlag(key: string, enabled: boolean): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
}

export interface AuditEvent {
  actor: string;
  command: string;
  args: Record<string, string>;
  reason: string;
  environment: string;
}

interface CommandDef {
  summary: string;
  args: Record<string, string>;
  plan(args: Record<string, string>): string;
  run(db: OpsDb, args: Record<string, string>): Promise<void>;
}

export const COMMANDS: Record<string, CommandDef> = {
  "outbox:requeue": {
    summary: "Reset an outbox row so the dispatcher redelivers it.",
    args: { id: "Outbox row id (uuid)" },
    plan: (a) => `Would clear dispatched_at and attempts on outbox row ${a.id}`,
    run: (db, a) => db.requeueOutbox(a.id),
  },
  "rate-limit:reset": {
    summary: "Delete a rate-limit key so the caller is unblocked.",
    args: { key: "Rate-limit key, e.g. attestation-lookup:203.0.113.7" },
    plan: (a) => `Would delete rate_limits row ${a.key}`,
    run: (db, a) => db.resetRateLimit(a.key),
  },
  "flag:set": {
    summary: "Enable or disable a feature flag / kill switch.",
    args: { key: "Flag key from FLAG_REGISTRY", enabled: "true or false" },
    plan: (a) => `Would set feature flag ${a.key} enabled=${a.enabled}`,
    run: (db, a) => db.setFlag(a.key, a.enabled === "true"),
  },
  "gameday:list": {
    summary: "List the game-day scenario catalog (issue #945).",
    args: {},
    plan: () => `Would list ${GAME_DAY_SCENARIOS.length} game-day scenarios`,
    run: async () => {},
  },
  "gameday:plan": {
    summary:
      "Print the safe staging injection steps for one game-day scenario.",
    args: { scenario: "Scenario id from `gameday:list`" },
    plan: (a) => `Would print the injection plan for scenario ${a.scenario}`,
    run: async () => {},
  },
};

export interface GameDayScenario {
  id: string;
  title: string;
  /** What the scenario simulates, in one sentence. */
  injects: string;
  /** Staging-only injection steps, in order. Never run against production. */
  steps: string[];
  /** Signals the observers watch for while the scenario is live. */
  signals: string[];
  /** Kill switches / operator commands used to abort or recover. */
  recovery: string[];
}

/**
 * Game-day scenario catalog (issue #945). Every scenario is injected in a
 * staging environment only; steps must never touch production data, PHI, or
 * live capability tokens. See docs/operations/game-days.md.
 */
export const GAME_DAY_SCENARIOS: GameDayScenario[] = [
  {
    id: "soroban-rpc-wrong-data",
    title: "Soroban RPC returns wrong data",
    injects:
      "Staging RPC proxy returns a valid-looking but incorrect ledger/attestation payload.",
    steps: [
      "Point STELLAR_RPC_URL at the staging fault proxy with mode=wrong-data.",
      "Trigger an attestation lookup for a seeded test record.",
      "Confirm the app treats the payload as untrusted and does not mark it verified.",
    ],
    signals: [
      "Attestation verification fails closed (unknown, not trusted).",
      "No ledger-aware consistency error is swallowed silently.",
    ],
    recovery: [
      "Restore STELLAR_RPC_URL to the real staging RPC endpoint.",
      "ops flag:set --key attestation_lookup --enabled false --reason gameday --env staging",
    ],
  },
  {
    id: "supabase-region-outage",
    title: "Supabase region outage",
    injects:
      "Staging database becomes unreachable (network block to the Supabase host).",
    steps: [
      "Apply the staging network policy that drops traffic to the Supabase host.",
      "Exercise sign-in, profile read, and emergency card lookup.",
      "Check readiness endpoint and error budget dashboards.",
    ],
    signals: [
      "Readiness reports not-ready; requests fail fast rather than hang.",
      "No PHI is written to logs or fallback stores.",
    ],
    recovery: [
      "Remove the staging network policy.",
      "Confirm readiness returns to ready and outbox drains.",
    ],
  },
  {
    id: "sms-provider-outage",
    title: "SMS provider outage",
    injects:
      "Termii/Twilio staging credentials are pointed at a failing mock endpoint.",
    steps: [
      "Set the SMS provider base URL to the staging failure mock (HTTP 503).",
      "Request a phone OTP and an emergency-contact notification.",
      "Verify retries, outbox backoff, and user-facing error copy.",
    ],
    signals: [
      "OTP requests fail with a retryable error, never a silent success.",
      "Outbox rows remain queued and are redelivered after recovery.",
    ],
    recovery: [
      "Restore the SMS provider base URL.",
      "ops outbox:requeue --id <row> --reason gameday --env staging",
    ],
  },
  {
    id: "capability-token-leak",
    title: "Capability token leak",
    injects:
      "A seeded staging capability token is exposed to a simulated third party.",
    steps: [
      "Issue a capability share link for a seeded test record in staging.",
      "Simulate the leak by resolving the token from an untrusted client.",
      "Revoke the capability and confirm the link stops resolving.",
    ],
    signals: [
      "Revocation takes effect immediately on the next resolve.",
      "Access is logged without persisting the token value.",
    ],
    recovery: [
      "ops flag:set --key capability_sharing --enabled false --reason gameday --env staging",
      "Re-enable capability_sharing once the leaked token is revoked.",
    ],
  },
  {
    id: "payout-key-compromise",
    title: "Payout signing key compromise",
    injects:
      "Staging payout signer key is marked compromised and rotated mid-run.",
    steps: [
      "Disable payouts with the kill switch before rotating the key.",
      "Rotate the staging payout signer key per the rotation runbook.",
      "Attempt a payout and confirm it is rejected while the switch is off.",
    ],
    signals: [
      "No funds move while payouts are disabled.",
      "Payout indexer resumes cleanly after the key rotation.",
    ],
    recovery: [
      "ops flag:set --key payouts --enabled true --reason gameday --env staging",
      "Reconcile the payout indexer against the ledger.",
    ],
  },
];

export function findScenario(id: string): GameDayScenario | undefined {
  return GAME_DAY_SCENARIOS.find((s) => s.id === id);
}

export function renderScenarioPlan(scenario: GameDayScenario): string {
  const section = (title: string, items: string[]) =>
    [`## ${title}`, "", ...items.map((i) => `- ${i}`), ""].join("\n");
  return [
    `# Game day: ${scenario.title} (\`${scenario.id}\`)`,
    "",
    scenario.injects,
    "",
    "Staging only. Never run these steps against production.",
    "",
    section("Injection steps", scenario.steps),
    section("Signals to observe", scenario.signals),
    section("Recovery", scenario.recovery),
  ].join("\n");
}

export function parseArgv(argv: string[]): {
  command?: string;
  flags: Record<string, string>;
} {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "true";
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { command, flags };
}

export function renderDocs(): string {
  const lines = [
    "# Operator CLI",
    "",
    "<!-- Generated by `node lib/ops/cli.ts docs`; do not edit by hand. -->",
    "",
    "All commands are dry runs unless `--execute` is passed. `--reason` and `--env` are",
    "always required; `--env production` also requires `--confirm-production`. Set",
    "`LAFIYA_OPERATOR_ACCESS_TOKEN` to your own Supabase session token (admin role, MFA).",
    "",
  ];
  for (const [name, def] of Object.entries(COMMANDS)) {
    lines.push(
      `## \`${name}\``,
      "",
      def.summary,
      "",
      "| Flag | Description |",
      "|---|---|",
    );
    for (const [arg, desc] of Object.entries(def.args))
      lines.push(`| \`--${arg}\` | ${desc} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface RunDeps {
  authenticate(): Promise<Operator>;
  db: OpsDb;
  log(line: string): void;
}

/** Validates, then either prints the plan (dry run) or executes and audits. */
export async function runCommand(
  argv: string[],
  deps: RunDeps,
): Promise<number> {
  const { command, flags } = parseArgv(argv);
  const def = command ? COMMANDS[command] : undefined;
  if (!command || !def) {
    deps.log(`Unknown command. Available: ${Object.keys(COMMANDS).join(", ")}`);
    return 2;
  }
  const missing = [...Object.keys(def.args), "reason", "env"].filter(
    (k) => !flags[k] || flags[k] === "true",
  );
  if (missing.length > 0) {
    deps.log(
      `Missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`,
    );
    return 2;
  }
  if (command === "flag:set" && !["true", "false"].includes(flags.enabled)) {
    deps.log("--enabled must be true or false");
    return 2;
  }
  if (command === "gameday:plan" && !findScenario(flags.scenario)) {
    deps.log(
      `Unknown scenario. Available: ${GAME_DAY_SCENARIOS.map((s) => s.id).join(", ")}`,
    );
    return 2;
  }

  const args = Object.fromEntries(
    Object.keys(def.args).map((k) => [k, flags[k]]),
  );
  const plan = def.plan(args);
  if (command === "gameday:list") {
    deps.log(
      GAME_DAY_SCENARIOS.map((s) => `${s.id}\t${s.title}`).join("\n"),
    );
    return 0;
  }
  if (command === "gameday:plan") {
    const scenario = findScenario(args.scenario);
    if (scenario) deps.log(renderScenarioPlan(scenario));
    return 0;
  }
  if (flags.execute !== "true") {    deps.log(
      `[dry-run] ${plan} (env=${flags.env}). Re-run with --execute to apply.`,
    );
    return 0;
  }
  if (flags.env === "production" && flags["confirm-production"] !== "true") {
    deps.log(
      "Refusing to execute against production without --confirm-production.",
    );
    return 3;
  }

  const operator = await deps.authenticate();
  await def.run(deps.db, args);
  await deps.db.audit({
    actor: operator.id,
    command,
    args,
    reason: flags.reason,
    environment: flags.env,
  });
  deps.log(`[executed] ${plan.replace(/^Would /, "")} (actor=${operator.id})`);
  return 0;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

export function supabaseDeps(): RunDeps {
  let client: SupabaseClient | null = null;
  // Created lazily so validation errors surface before credential errors.
  const db = (): SupabaseClient => {
    if (client) return client;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey)
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
      );
    client = createClient(url, serviceKey, { auth: { persistSession: false } });
    return client;
  };
  const check = async (
    p: PromiseLike<{ error: { message: string } | null }>,
  ) => {
    const { error } = await p;
    if (error) throw new Error(error.message);
  };

  return {
    log: (line) => console.log(line),
    async authenticate() {
      const token = process.env.LAFIYA_OPERATOR_ACCESS_TOKEN;
      if (!token)
        throw new Error(
          "LAFIYA_OPERATOR_ACCESS_TOKEN is required to execute commands",
        );
      const { data, error } = await db().auth.getUser(token);
      if (error || !data.user)
        throw new Error("Operator session is invalid or expired");
      if (data.user.app_metadata?.role !== "admin")
        throw new Error("Operator lacks the admin role");
      if (decodeJwtPayload(token).aal !== "aal2")
        throw new Error("Operator session must be MFA-verified (aal2)");
      return { id: data.user.id };
    },
    db: {
      requeueOutbox: (id) =>
        check(
          db()
            .from("outbox")
            .update({ dispatched_at: null, attempts: 0 })
            .eq("id", id),
        ),
      resetRateLimit: (key) =>
        check(db().from("rate_limits").delete().eq("key", key)),
      setFlag: (key, enabled) =>
        check(db().from("feature_flags").update({ enabled }).eq("key", key)),
      audit: (e) =>
        check(
          db().from("operator_audit_log").insert({
            actor_id: e.actor,
            command: e.command,
            args: e.args,
            reason: e.reason,
            environment: e.environment,
          }),
        ),
    },
  };
}

if (process.argv[1]?.endsWith("lib/ops/cli.ts")) {
  const argv = process.argv.slice(2);
  if (argv[0] === "docs") {
    console.log(renderDocs());
  } else {
    const deps = argv.includes("--execute") ? supabaseDeps() : dryRunDeps();
    runCommand(argv, deps).then(
      (code) => process.exit(code),
      (err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      },
    );
  }
}

/** Dry runs never touch the database, so they need no credentials. */
function dryRunDeps(): RunDeps {
  const refuse = async () => {
    throw new Error("dry run must not reach the database");
  };
  return {
    log: console.log,
    authenticate: refuse,
    db: {
      requeueOutbox: refuse,
      resetRateLimit: refuse,
      setFlag: refuse,
      audit: refuse,
    },
  };
}
