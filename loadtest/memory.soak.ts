/**
 * Issue #785: soak scenario for long-lived instances. Drives the in-process
 * handlers and caches that keep module-level state (analytics and vitals rate
 * buckets, vitals aggregation, session-touch throttle, breached-password
 * prefix cache) with a realistic traffic mix and high key cardinality, while
 * sampling heap-after-GC, active handles and event-loop lag.
 *
 * Fails if the heap trend over the post-warm-up window projects growth above
 * SOAK_HEAP_GROWTH_LIMIT_MB, or if active handles accumulate. Writes
 * artifacts/soak/{samples.csv,heap.svg,summary.json}.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { POST as postEvent } from "@/app/api/e/route";
import { GET as getVitals, POST as postVitals } from "@/app/api/vitals/route";
import { isBreachedPassword } from "@/lib/security/breached-password";
import { createSessionTouchThrottle } from "@/lib/sessions/throttle";

const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 60_000);
const SAMPLES = Number(process.env.SOAK_SAMPLES ?? 60);
const HEAP_GROWTH_LIMIT_MB = Number(
  process.env.SOAK_HEAP_GROWTH_LIMIT_MB ?? 32,
);
const HANDLE_GROWTH_LIMIT = Number(process.env.SOAK_HANDLE_GROWTH_LIMIT ?? 20);
const OUT_DIR = join(process.cwd(), "artifacts", "soak");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

interface Sample {
  elapsedMs: number;
  heapUsedMb: number;
  activeHandles: number;
  loopLagP99Ms: number;
  requests: number;
}

const randomIp = () =>
  Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join(".");

function request(url: string, body: unknown, ip: string): NextRequest {
  const text = JSON.stringify(body);
  return new NextRequest(url, {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/json",
      "content-length": String(text.length),
      "user-agent": "Mozilla/5.0 (soak)",
      "x-forwarded-for": ip,
    },
  });
}

const throttle = createSessionTouchThrottle();
const ROUTE_CLASSES = ["card", "profile", "auth", "landing"];
const METRICS = ["LCP", "INP", "CLS", "TTFB"];

async function trafficStep(i: number) {
  const ip = randomIp();
  switch (i % 5) {
    case 0:
      await postEvent(
        request(
          "http://soak.test/api/e",
          { event: "card_viewed", props: { route: "/c" } },
          ip,
        ),
      );
      break;
    case 1:
      await postVitals(
        request(
          "http://soak.test/api/vitals",
          {
            routeClass: ROUTE_CLASSES[i % ROUTE_CLASSES.length],
            metric: METRICS[i % METRICS.length],
            value: Math.random() * 4000,
            connection: "unknown",
            memory: "unknown",
          },
          ip,
        ),
      );
      break;
    case 2:
      throttle.shouldTouch(crypto.randomUUID());
      break;
    case 3:
      await isBreachedPassword(`soak-password-${i}`);
      break;
    case 4:
      if (i % 500 === 4) await getVitals();
      break;
  }
}

function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((acc, x, k) => acc + (x - mx) * (ys[k]! - my), 0);
  const den = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

function svgChart(samples: Sample[], key: keyof Sample, label: string): string {
  const w = 720;
  const h = 240;
  const pad = 40;
  const values = samples.map((s) => s[key]);
  const max = Math.max(...values, 1);
  const lastT = samples.at(-1)?.elapsedMs || 1;
  const points = samples
    .map((s) => {
      const x = pad + ((w - 2 * pad) * s.elapsedMs) / lastT;
      const y = h - pad - ((h - 2 * pad) * s[key]) / max;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#fff"/>
<text x="${pad}" y="20">${label} (max ${max.toFixed(1)}) over ${(lastT / 60_000).toFixed(1)} min</text>
<line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#999"/>
<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="#999"/>
<polyline fill="none" stroke="#2563eb" stroke-width="2" points="${points}"/>
</svg>
`;
}

describe("soak: long-lived instance memory and handles", () => {
  it(`stays flat over ${DURATION_MS / 60_000} minutes of high-cardinality traffic`, async () => {
    // HIBP is external; answer every range lookup with a small fixed body.
    // Plain functions, not vi.fn(): mocks record every call and would
    // themselves look like a leak.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("0018A45C4D1DEF81644B54AB7F969B88D65:1\n", {
          status: 200,
        }),
    );
    const warn = console.warn;
    console.warn = () => {};

    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    const samples: Sample[] = [];
    const start = performance.now();
    const interval = DURATION_MS / SAMPLES;
    let requests = 0;
    let nextSample = 0;

    while (performance.now() - start < DURATION_MS) {
      for (let k = 0; k < 200; k++) await trafficStep(requests++);
      const elapsedMs = performance.now() - start;
      if (elapsedMs >= nextSample) {
        gc();
        samples.push({
          elapsedMs,
          heapUsedMb: process.memoryUsage().heapUsed / 1024 / 1024,
          activeHandles: process.getActiveResourcesInfo().length,
          loopLagP99Ms: lag.percentile(99) / 1e6,
          requests,
        });
        lag.reset();
        nextSample += interval;
      }
      // Yield so timers and the lag monitor run.
      await new Promise((resolve) => setImmediate(resolve));
    }
    lag.disable();
    vi.unstubAllGlobals();
    console.warn = warn;

    // Ignore the first 20% as warm-up (JIT, caches filling to their bounds).
    const steady = samples.slice(Math.floor(samples.length * 0.2));
    const heapSlopePerMs = slope(
      steady.map((s) => s.elapsedMs),
      steady.map((s) => s.heapUsedMb),
    );
    const projectedHeapGrowthMb = heapSlopePerMs * DURATION_MS;
    const quarter = Math.max(1, Math.floor(samples.length / 4));
    const handleGrowth =
      Math.max(...samples.slice(-quarter).map((s) => s.activeHandles)) -
      Math.min(...samples.slice(0, quarter).map((s) => s.activeHandles));
    const summary = {
      durationMs: DURATION_MS,
      requests,
      samples: samples.length,
      projectedHeapGrowthMb,
      heapGrowthLimitMb: HEAP_GROWTH_LIMIT_MB,
      handleGrowth,
      handleGrowthLimit: HANDLE_GROWTH_LIMIT,
      maxLoopLagP99Ms: Math.max(...samples.map((s) => s.loopLagP99Ms)),
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, "samples.csv"),
      "elapsed_ms,heap_used_mb,active_handles,loop_lag_p99_ms,requests\n" +
        samples
          .map((s) =>
            [
              s.elapsedMs.toFixed(0),
              s.heapUsedMb.toFixed(2),
              s.activeHandles,
              s.loopLagP99Ms.toFixed(2),
              s.requests,
            ].join(","),
          )
          .join("\n") +
        "\n",
    );
    writeFileSync(
      join(OUT_DIR, "heap.svg"),
      svgChart(samples, "heapUsedMb", "Heap used after GC (MB)"),
    );
    writeFileSync(
      join(OUT_DIR, "handles.svg"),
      svgChart(samples, "activeHandles", "Active handles"),
    );
    writeFileSync(
      join(OUT_DIR, "event-loop-lag.svg"),
      svgChart(samples, "loopLagP99Ms", "Event-loop lag p99 (ms)"),
    );
    writeFileSync(
      join(OUT_DIR, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );

    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(projectedHeapGrowthMb).toBeLessThan(HEAP_GROWTH_LIMIT_MB);
    expect(handleGrowth).toBeLessThanOrEqual(HANDLE_GROWTH_LIMIT);
  });
});
