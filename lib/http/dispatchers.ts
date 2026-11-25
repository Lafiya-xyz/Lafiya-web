import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * Named outbound HTTP dispatchers (Issue #881).
 *
 * Node's default `fetch` dispatcher keeps an unbounded per-origin pool with a
 * 4s keep-alive and HTTP/1.1 only. For the few upstreams this app calls on
 * hot paths that means repeated TLS handshakes to distant regions during
 * bursts, and no ceiling on sockets. Each upstream class gets its own tuned
 * `undici.Agent` instead; see docs/outbound-http-agents.md for the rationale
 * behind every number.
 */

export type UpstreamName = "soroban" | "notifications";

const PROFILES: Record<UpstreamName, Agent.Options> = {
  // Card-route critical path: few hosts, many small JSON-RPC POSTs.
  soroban: {
    allowH2: true,
    connections: 16,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    connectTimeout: 1_500,
    headersTimeout: 2_000,
    bodyTimeout: 2_000,
  },
  // SMS/email providers: background outbox traffic, latency-tolerant.
  notifications: {
    allowH2: true,
    connections: 8,
    pipelining: 1,
    keepAliveTimeout: 15_000,
    keepAliveMaxTimeout: 60_000,
    connectTimeout: 5_000,
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  },
};

const agents = new Map<UpstreamName, Dispatcher>();

/** Lazily-built, process-wide dispatcher for an upstream class. */
export function getDispatcher(name: UpstreamName): Dispatcher {
  let agent = agents.get(name);
  if (!agent) {
    agent = new Agent(PROFILES[name]);
    agents.set(name, agent);
  }
  return agent;
}

/**
 * `fetch` through the named upstream dispatcher.
 *
 * Uses undici's own `fetch` rather than Node's global one: a dispatcher from
 * the `undici` package is only guaranteed to be compatible with the `fetch`
 * from the same package version (Node 24 bundles undici 7, whose global
 * `fetch` rejects undici 8 handlers with "invalid onRequestStart method").
 */
export async function upstreamFetch(
  name: UpstreamName,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: getDispatcher(name),
  });
  return response as unknown as Response;
}
