// ---------------------------------------------------------------------------
// Soroban RPC / Horizon provider benchmark harness.
//
// Measures the exact query shapes the app issues today (see
// lib/stellar/attestation.ts and lib/stellar/payout-indexer/sources.ts) plus
// the RPC methods a Horizon→RPC migration would use, against every candidate
// provider. Output is machine-readable JSON so results are reproducible and
// comparable across regions/runs.
//
// NO patient data is used. Every probe uses either synthetic keys or public
// chain data (a well-known contract, the most recent public payment, etc.).
//
// Usage:
//   node bench/rpc-provider-benchmark/harness.mjs
//   node bench/rpc-provider-benchmark/harness.mjs --iterations 25 --out results/x.json
//   node bench/rpc-provider-benchmark/harness.mjs --only 'nodies|gateway'
//
// Run it from the region you care about (e.g. a Lagos VPS or GCP africa-south1
// VM) to measure real regional latency; see bench/rpc-provider-benchmark/README.md.
// ---------------------------------------------------------------------------

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const ITERATIONS = Number(argValue("--iterations", "10"));
const OUT_PATH = argValue("--out", "");
const ONLY = argValue("--only", "");
const SKIP = argValue("--skip", "");
const TIMEOUT_MS = Number(argValue("--timeout", "8000"));

// Native XLM Stellar Asset Contract — deployed on every Soroban network at a
// well-known address. `symbol()` is a no-arg read-only call, so it exercises
// simulateTransaction exactly like lib/stellar/attestation.ts does for
// get_attestation, without needing the lafiya-contracts deployment.
const NATIVE_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const NETWORK_PASSPHRASE = {
  futurenet: "Test SDF Future Network ; October 2022",
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

// ── Providers ──────────────────────────────────────────────────────────────
// Sources: https://developers.stellar.org/docs/data/apis/rpc/providers and
// https://developers.stellar.org/docs/data/apis/horizon/providers (fetched
// 2026-08-20). SDF does not operate a public *mainnet* RPC (only testnet and
// futurenet), which is why all mainnet RPC entries below are third-party.
const RPC_PROVIDERS = [
  { id: "sdf-testnet", kind: "rpc", network: "testnet", url: "https://soroban-testnet.stellar.org" },
  { id: "sdf-futurenet", kind: "rpc", network: "futurenet", url: "https://rpc-futurenet.stellar.org" },
  { id: "sorobanrpc.com-mainnet", kind: "rpc", network: "mainnet", url: "https://mainnet.sorobanrpc.com" },
  { id: "nodies-testnet", kind: "rpc", network: "testnet", url: "https://stellar-soroban-testnet-public.nodies.app" },
  { id: "nodies-mainnet", kind: "rpc", network: "mainnet", url: "https://stellar-soroban-public.nodies.app" },
  { id: "gateway-testnet", kind: "rpc", network: "testnet", url: "https://soroban-rpc.testnet.stellar.gateway.fm" },
  { id: "gateway-mainnet", kind: "rpc", network: "mainnet", url: "https://soroban-rpc.mainnet.stellar.gateway.fm" },
  { id: "onfinality-mainnet", kind: "rpc", network: "mainnet", url: "https://stellar.api.onfinality.io/public" },
  { id: "lightsail-mainnet", kind: "rpc", network: "mainnet", url: "https://rpc.lightsail.network/" },
  { id: "lightsail-archive-mainnet", kind: "rpc", network: "mainnet", url: "https://archive-rpc.lightsail.network/" },
  { id: "ankr-mainnet", kind: "rpc", network: "mainnet", url: "https://rpc.ankr.com/stellar_soroban" },
  { id: "liquify-testnet", kind: "rpc", network: "testnet", url: "https://stellar.liquify.com/api=41EEWAH79Y5OCGI7/testnet" },
];

const HORIZON_PROVIDERS = [
  { id: "sdf-horizon-testnet", kind: "horizon", network: "testnet", url: "https://horizon-testnet.stellar.org" },
  { id: "sdf-horizon-mainnet", kind: "horizon", network: "mainnet", url: "https://horizon.stellar.org" },
  { id: "lobstr-horizon-mainnet", kind: "horizon", network: "mainnet", url: "https://horizon.stellar.lobstr.co" },
];

// ── Probe definitions ──────────────────────────────────────────────────────

/**
 * Issue a JSON-RPC 2.0 request. Returns the decoded JSON body; throws
 * { kind: "http", status } for non-2xx and { kind: "rpc" } for JSON-RPC errors
 * so the harness can classify throttling separately from normal latency.
 */
async function rpcRequest(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { kind: "http", status: res.status });
  }
  const body = await res.json();
  if (body && body.error) {
    throw Object.assign(new Error(`RPC error: ${body.error.code} ${body.error.message ?? ""}`), {
      kind: "rpc",
      code: body.error.code,
    });
  }
  return body;
}

// get_attestation-equivalent: read-only simulateTransaction against a
// well-known contract. Reuses the SDK exactly like lib/stellar/attestation.ts.
//
// A *host* error (e.g. MissingValue from archived contract state on mainnet)
// is a contract-state outcome, not a provider failure: the RPC round-trip
// still completed. We therefore return the host success/failure boolean and
// only let transport/HTTP errors (which the SDK throws) count as failures.
async function simulateSymbol(url, network) {
  const server = new rpc.Server(url, {
    allowHttp: new URL(url).protocol === "http:",
  });
  const contract = new Contract(NATIVE_SAC);
  const tx = new TransactionBuilder(
    new Account(Keypair.random().publicKey(), "0"),
    { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE[network] },
  )
    .addOperation(contract.call("symbol"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return rpc.Api.isSimulationSuccess(sim);
}

// getTransactions — the exact method SorobanAttestationSource.read() uses to
// page through the ledger for `attest` invocations.
async function getTransactions(url, latestLedger) {
  const startLedger = Math.max(0, (latestLedger ?? 0) - 1000);
  await rpcRequest(url, "getTransactions", {
    startLedger,
    pagination: { limit: 100 },
  });
}

// getEvents — the RPC-native event query a payout indexer would use after the
// Horizon→RPC migration (CAP-67 / contract events).
async function getEvents(url, _oldestLedger, latestLedger) {
  // Query a small, recent window (not the whole retention range) — this is
  // both deterministic and representative of an indexer paging forward from
  // its last cursor, and avoids racing the retention window's left edge.
  await rpcRequest(url, "getEvents", {
    startLedger: Math.max(0, (latestLedger ?? 0) - 200),
    endLedger: latestLedger ?? 0,
    pagination: { limit: 100 },
  });
}

const RPC_PROBES = {
  getHealth: (url) => rpcRequest(url, "getHealth", undefined),
  getLatestLedger: (url) => rpcRequest(url, "getLatestLedger", undefined),
  getNetwork: (url) => rpcRequest(url, "getNetwork", undefined),
  getTransactions: (url, health) =>
    getTransactions(url, health?.result?.latestLedger ?? 0),
  getEvents: (url, health) =>
    getEvents(
      url,
      health?.result?.oldestLedger ?? health?.result?.latestLedger - 200,
      health?.result?.latestLedger ?? 0,
    ),
  simulateTransaction: (url, _health, network) => simulateSymbol(url, network),
};

// Discover a recent *classic* payment so the dependent probes need no
// hard-coded account and use no patient data. Returns { account, transactionHash }.
async function discoverRecentPayment(url) {
  const res = await fetch(`${url}/payments?order=desc&limit=20`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: "http", status: res.status });
  const json = await res.json();
  for (const rec of json._embedded?.records ?? []) {
    const account = rec.from ?? rec.to ?? rec.account ?? rec.source_account;
    if (account && rec.transaction_hash) {
      return { account, transactionHash: rec.transaction_hash };
    }
  }
  const first = json._embedded?.records?.[0];
  return { account: first?.account ?? null, transactionHash: first?.transaction_hash ?? null };
}

const HORIZON_PROBES = {
  // GET / — Horizon health/version (what a load balancer would poll).
  root: (url) => fetch(`${url}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then(async (r) => {
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { kind: "http", status: r.status });
    return r.text();
  }),
  // Recent-payment discovery (also used as a dependency for the probes below).
  recentPayment: (url) => discoverRecentPayment(url),
  // payments().forAccount(poolAddress).cursor().order("asc").limit(100) —
  // the exact query HorizonPayoutSource.read() issues for the pool account.
  accountPayments: (url, recent) => {
    const account = recent?.account;
    if (!account) throw Object.assign(new Error("no account to probe"), { kind: "rpc" });
    return fetch(
      `${url}/accounts/${account}/payments?order=asc&limit=100`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    ).then(async (r) => {
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { kind: "http", status: r.status });
      return r.json();
    });
  },
  // operation.transaction() — the N+1 transaction fetch the payout source
  // performs per payment to read the memo (record hash).
  transactionByHash: (url, recent) => {
    const hash = recent?.transactionHash;
    if (!hash) throw Object.assign(new Error("no tx to probe"), { kind: "rpc" });
    return fetch(`${url}/transactions/${hash}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then(async (r) => {
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { kind: "http", status: r.status });
      return r.json();
    });
  },
};

// ── Aggregation ────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function classify(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (error?.kind === "http") {
    if (error.status === 429) return "http_429_throttled";
    if (error.status >= 500) return `http_${error.status}_server`;
    return `http_${error.status}`;
  }
  if (error?.kind === "rpc") {
    const msg = String(error.message ?? "");
    if (/rate|limit|throttl|too many|429|quota/i.test(msg)) return "rpc_throttled";
    return "rpc_error";
  }
  return "network_error";
}

function summarize(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const failures = {};
  const errors = new Set();
  for (const s of samples) {
    if (!s.ok) {
      const key = s.classification;
      failures[key] = (failures[key] ?? 0) + 1;
      errors.add(`${s.classification}: ${s.error}`);
    }
  }
  const hostSuccess = samples.filter((s) => s.ok && s.value === true).length;
  const hostError = samples.filter((s) => s.ok && s.value === false).length;
  const summary = {
    attempts: samples.length,
    ok: ok.length,
    failures,
    errors: [...errors].slice(0, 5),
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    p99: percentile(ok, 99),
    min: ok.length ? ok[0] : null,
    max: ok.length ? ok[ok.length - 1] : null,
    mean: ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
  };
  // Only relevant for simulateTransaction (which returns a boolean host result).
  if (hostSuccess + hostError > 0) {
    summary.hostSuccess = hostSuccess;
    summary.hostError = hostError;
  }
  return summary;
}

async function runProbe(fn, ...deps) {
  const t0 = Date.now();
  try {
    const value = await fn(...deps);
    return { ok: true, ms: Date.now() - t0, value };
  } catch (error) {
    return { ok: false, ms: Date.now() - t0, classification: classify(error), error: String(error.message ?? error) };
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function benchmarkProvider(provider) {
  const isRpc = provider.kind === "rpc";
  const probes = isRpc ? RPC_PROBES : HORIZON_PROBES;

  // Health/version once up front to (a) establish reachability and (b) feed
  // ledger-range/account discovery into the dependent probes.
  let health = null;
  let healthFailure = null;
  try {
    health = isRpc
      ? await rpcRequest(provider.url, "getHealth", undefined)
      : await (await fetch(`${provider.url}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) })).text();
  } catch (error) {
    healthFailure = classify(error);
  }

  const retention = isRpc && health?.result
    ? {
        ledgerRetentionWindow: health.result.ledgerRetentionWindow ?? null,
        oldestLedger: health.result.oldestLedger ?? null,
        latestLedger: health.result.latestLedger ?? null,
      }
    : null;

  const out = {
    id: provider.id,
    kind: provider.kind,
    network: provider.network,
    url: provider.url,
    retention,
    healthFailure,
    probes: {},
  };

  // Horizon probes share one "recent payment" dependency to stay realistic and
  // deterministic without hard-coding an account.
  const recentPayment = isRpc
    ? null
    : await (async () => {
        try {
          return await discoverRecentPayment(provider.url);
        } catch {
          return null;
        }
      })();

  for (const [name, fn] of Object.entries(probes)) {
    const samples = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const deps = isRpc
        ? [provider.url, health, provider.network]
        : name === "accountPayments" || name === "transactionByHash"
          ? [provider.url, recentPayment]
          : name === "recentPayment"
            ? [provider.url]
            : [provider.url];
      samples.push(await runProbe(fn, ...deps));
    }
    out.probes[name] = summarize(samples);
  }

  return out;
}

function renderTable(results) {
  const rows = [];
  for (const r of results) {
    for (const [probe, s] of Object.entries(r.probes)) {
      rows.push({
        provider: r.id,
        network: r.network,
        probe,
        p50: s.p50 ?? "-",
        p95: s.p95 ?? "-",
        p99: s.p99 ?? "-",
        ok: `${s.ok}/${s.attempts}`,
        failures: Object.entries(s.failures).map(([k, v]) => `${k}=${v}`).join(" ") || "-",
      });
    }
  }
  return rows;
}

async function main() {
  const providers = [...RPC_PROVIDERS, ...HORIZON_PROVIDERS].filter((p) => {
    if (ONLY && !new RegExp(ONLY, "i").test(p.id)) return false;
    if (SKIP && new RegExp(SKIP, "i").test(p.id)) return false;
    return true;
  });

  console.error(`Benchmarking ${providers.length} providers, ${ITERATIONS} iterations/probe, timeout ${TIMEOUT_MS}ms`);
  const results = [];
  for (const p of providers) {
    console.error(`\n== ${p.id} (${p.network}) ==`);
    const r = await benchmarkProvider(p);
    results.push(r);
    const rows = renderTable([r]);
    console.table(rows.map((row) => ({
      probe: row.probe,
      "p50": row.p50,
      "p95": row.p95,
      "p99": row.p99,
      "ok": row.ok,
      "failures": row.failures,
    })));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    iterations: ITERATIONS,
    timeoutMs: TIMEOUT_MS,
    note: "Latencies are wall-clock ms from the machine that ran the harness (see README for region guidance). Failures/throttling are recorded separately from normal latency samples.",
    results,
  };

  const json = JSON.stringify(report, null, 2);
  if (OUT_PATH) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, json);
    console.error(`\nWrote ${OUT_PATH}`);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
