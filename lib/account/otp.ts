import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env-server";
import type { Database } from "@/lib/supabase/types";

import type { OtpVerifier } from "./merge";

function statelessClient() {
  return createClient<Database>(
    serverEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Email one-time codes through Supabase Auth. Each call uses its own
 * in-memory client so verifying the other account never replaces the
 * requester's session; the session a successful verification creates is
 * signed out immediately.
 */
export const supabaseEmailOtp: OtpVerifier = {
  async send(email) {
    const { error } = await statelessClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) throw new Error("OTP_SEND_FAILED");
  },
  async verify(email, code) {
    if (!/^[0-9]{6,10}$/.test(code)) return false;
    const client = statelessClient();
    const { data, error } = await client.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error || !data.session) return false;
    await client.auth.signOut({ scope: "local" });
    return true;
  },
};

/* -------------------------------------------------------------------------- */
/* SIM-swap risk detection                                                    */
/* -------------------------------------------------------------------------- */

/**
 * SIM-swap detection for phone OTP sign-in and recovery.
 *
 * Policy (see issue #968):
 * - A recent swap (within `SIM_SWAP_WINDOW_HOURS`, default 72h) forces
 *   stronger verification: OTP-only recovery is blocked and the user must
 *   complete recovery code / passkey / step-up. A security notification is
 *   sent by email.
 * - Fail-closed for recovery flows: if the provider is unavailable we treat
 *   the number as "recent swap" (block OTP-only recovery).
 * - Fail-open for sign-in flows: if the provider is unavailable we allow the
 *   OTP flow to proceed but log the degraded decision, because the user still
 *   holds the device and blocking all sign-ins on a provider outage would be
 *   a denial-of-service.
 *
 * Decisions are logged with a hashed phone reference only; plaintext phone
 * numbers are never written to logs.
 */

export type SimSwapFlow = "signin" | "recovery";

export type SimSwapStatus =
  | { kind: "no_recent_swap" }
  | { kind: "recent_swap"; swappedAt: Date | null }
  | { kind: "unavailable"; reason: string };

export interface SimSwapChecker {
  /** Returns whether the given E.164 phone number had a recent SIM swap. */
  check(phone: string): Promise<SimSwapStatus>;
}

export interface SimSwapDecision {
  /** True when the caller must require stronger verification. */
  requireStrongerVerification: boolean;
  /** True when a security notification should be sent to the account email. */
  notifySecurity: boolean;
  status: SimSwapStatus;
  flow: SimSwapFlow;
}

const DEFAULT_WINDOW_HOURS = 72;

function windowHours(): number {
  const raw = process.env.SIM_SWAP_WINDOW_HOURS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_HOURS;
}

/** Stable, non-reversible reference for logging without plaintext numbers. */
export function phoneLogRef(phone: string): string {
  // Simple non-cryptographic hash is sufficient for correlation in logs;
  // we never need to reverse it. Uses FNV-1a over the normalized number.
  const normalized = phone.replace(/[^0-9]/g, "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ph_${hash.toString(16).padStart(8, "0")}`;
}

function logDecision(decision: SimSwapDecision, phone: string): void {
  const ref = phoneLogRef(phone);
  const statusKind = decision.status.kind;
  const line = {
    event: "sim_swap_decision",
    flow: decision.flow,
    phoneRef: ref,
    status: statusKind,
    requireStrongerVerification: decision.requireStrongerVerification,
    notifySecurity: decision.notifySecurity,
    windowHours: windowHours(),
  };
  // Structured single-line log; no plaintext phone number.
  console.info(JSON.stringify(line));
}

/**
 * Applies the SIM-swap policy to a checker result for a given flow.
 * Pure function so it can be unit-tested and reused by both flows.
 */
export function applySimSwapPolicy(
  flow: SimSwapFlow,
  status: SimSwapStatus,
): SimSwapDecision {
  switch (status.kind) {
    case "recent_swap":
      return {
        requireStrongerVerification: true,
        notifySecurity: true,
        status,
        flow,
      };
    case "no_recent_swap":
      return {
        requireStrongerVerification: false,
        notifySecurity: false,
        status,
        flow,
      };
    case "unavailable":
      // Fail-closed for recovery, fail-open for sign-in.
      if (flow === "recovery") {
        return {
          requireStrongerVerification: true,
          notifySecurity: false,
          status,
          flow,
        };
      }
      return {
        requireStrongerVerification: false,
        notifySecurity: false,
        status,
        flow,
      };
  }
}

/**
 * Evaluates SIM-swap risk for a phone number in the given flow, logging the
 * decision (without plaintext phone numbers) and returning the policy result.
 */
export async function evaluateSimSwapRisk(
  checker: SimSwapChecker,
  flow: SimSwapFlow,
  phone: string,
): Promise<SimSwapDecision> {
  let status: SimSwapStatus;
  try {
    status = await checker.check(phone);
  } catch (err) {
    status = {
      kind: "unavailable",
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }
  const decision = applySimSwapPolicy(flow, status);
  logDecision(decision, phone);
  return decision;
}

/* -------------------------------------------------------------------------- */
/* Fake checker (tests / local dev)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic fake for tests and local development. Configure with a set of
 * phone numbers that should be treated as recently swapped, or a fixed status.
 */
export class FakeSimSwapChecker implements SimSwapChecker {
  private readonly recentSwaps: Set<string>;
  private readonly forcedStatus: SimSwapStatus | null;

  constructor(options: {
    recentSwaps?: string[];
    forcedStatus?: SimSwapStatus;
  } = {}) {
    this.recentSwaps = new Set(
      (options.recentSwaps ?? []).map((p) => p.replace(/[^0-9]/g, "")),
    );
    this.forcedStatus = options.forcedStatus ?? null;
  }

  async check(phone: string): Promise<SimSwapStatus> {
    if (this.forcedStatus) return this.forcedStatus;
    const normalized = phone.replace(/[^0-9]/g, "");
    if (this.recentSwaps.has(normalized)) {
      return { kind: "recent_swap", swappedAt: new Date() };
    }
    return { kind: "no_recent_swap" };
  }
}

/* -------------------------------------------------------------------------- */
/* Provider adapter (CAMARA SIM Swap API via aggregator)                      */
/* -------------------------------------------------------------------------- */

interface CamaraSimSwapConfig {
  baseUrl: string;
  apiKey: string;
  /** Optional aggregator-specific header name for the API key. */
  apiKeyHeader?: string;
  timeoutMs?: number;
}

function readCamaraConfig(): CamaraSimSwapConfig | null {
  const baseUrl = process.env.SIM_SWAP_API_BASE_URL;
  const apiKey = process.env.SIM_SWAP_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const timeoutRaw = process.env.SIM_SWAP_API_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
  return {
    baseUrl,
    apiKey,
    apiKeyHeader: process.env.SIM_SWAP_API_KEY_HEADER || "Authorization",
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
  };
}

/**
 * Adapter for a CAMARA-compliant SIM Swap API exposed by an aggregator
 * (e.g. GSMA Open Gateway). Uses the `retrieve-date` endpoint to obtain the
 * last swap timestamp and compares it against the configured window.
 *
 * If the provider is not configured, `check` reports `unavailable` so the
 * documented per-flow policy applies.
 */
export class CamaraSimSwapChecker implements SimSwapChecker {
  private readonly config: CamaraSimSwapConfig | null;

  constructor(config?: CamaraSimSwapConfig) {
    this.config = config ?? readCamaraConfig();
  }

  async check(phone: string): Promise<SimSwapStatus> {
    if (!this.config) {
      return { kind: "unavailable", reason: "provider_not_configured" };
    }
    const { baseUrl, apiKey, apiKeyHeader, timeoutMs } = this.config;
    const url = new URL(
      "/sim-swap/v0/retrieve-date",
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? 5000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [apiKeyHeader ?? "Authorization"]: apiKey,
        },
        body: JSON.stringify({ phoneNumber: phone }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { kind: "unavailable", reason: `http_${res.status}` };
      }
      const body = (await res.json()) as { latestSimChange?: string };
      if (!body.latestSimChange) {
        return { kind: "no_recent_swap" };
      }
      const swappedAt = new Date(body.latestSimChange);
      if (Number.isNaN(swappedAt.getTime())) {
        return { kind: "unavailable", reason: "invalid_timestamp" };
      }
      const cutoff = Date.now() - windowHours() * 60 * 60 * 1000;
      if (swappedAt.getTime() >= cutoff) {
        return { kind: "recent_swap", swappedAt };
      }
      return { kind: "no_recent_swap" };
    } catch (err) {
      return {
        kind: "unavailable",
        reason: err instanceof Error ? err.name : "fetch_error",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Default checker used by the app; falls back to the fake when unconfigured. */
export function defaultSimSwapChecker(): SimSwapChecker {
  return new CamaraSimSwapChecker();
}