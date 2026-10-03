import type { NextWebVitalsMetric } from "next/app";

export type RouteClass = "card" | "profile" | "auth" | "marketing";

export type ConnectionEffectiveType = "slow-2g" | "2g" | "3g" | "4g" | "unknown";

export type DeviceMemoryBucket = "low" | "mid" | "high" | "unknown";

export interface VitalsPayload {
  name: string;
  value: number;
  rating: string;
  routeClass: RouteClass;
  effectiveType: ConnectionEffectiveType;
  deviceMemory: DeviceMemoryBucket;
}

const SAMPLE_RATE = 0.1;

const ROUTE_CLASS_PREFIXES: ReadonlyArray<readonly [string, RouteClass]> = [
  ["/card", "card"],
  ["/profile", "profile"],
  ["/auth", "auth"],
];

/**
 * Map a pathname to a coarse route class. Only the class label is ever sent,
 * never the pathname itself, so card URLs and capability tokens cannot leak.
 */
export function classifyRoute(pathname: string | null | undefined): RouteClass {
  if (!pathname) {
    return "marketing";
  }
  for (const [prefix, routeClass] of ROUTE_CLASS_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return routeClass;
    }
  }
  return "marketing";
}

export function bucketEffectiveType(
  effectiveType: string | null | undefined,
): ConnectionEffectiveType {
  switch (effectiveType) {
    case "slow-2g":
    case "2g":
    case "3g":
    case "4g":
      return effectiveType;
    default:
      return "unknown";
  }
}

export function bucketDeviceMemory(
  deviceMemory: number | null | undefined,
): DeviceMemoryBucket {
  if (typeof deviceMemory !== "number" || !Number.isFinite(deviceMemory)) {
    return "unknown";
  }
  if (deviceMemory <= 2) {
    return "low";
  }
  if (deviceMemory <= 4) {
    return "mid";
  }
  return "high";
}

function readConnectionEffectiveType(): ConnectionEffectiveType {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string };
    }
  ).connection;
  return bucketEffectiveType(connection?.effectiveType);
}

function readDeviceMemory(): DeviceMemoryBucket {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory;
  return bucketDeviceMemory(deviceMemory);
}

/**
 * Shape a raw web-vitals metric into a privacy-safe payload. The payload
 * contains only the metric name/value/rating plus coarse environment labels;
 * no URLs, query strings, or tokens are included.
 */
export function shapeVitalsPayload(
  metric: Pick<NextWebVitalsMetric, "name" | "value"> & { rating?: string },
  pathname: string | null | undefined,
): VitalsPayload {
  return {
    name: metric.name,
    value: metric.value,
    rating: metric.rating ?? "unknown",
    routeClass: classifyRoute(pathname),
    effectiveType: readConnectionEffectiveType(),
    deviceMemory: readDeviceMemory(),
  };
}

/**
 * Decide whether this page view is part of the 10% sample. Uses a stable
 * per-session decision so a single visit is either fully sampled or not.
 */
export function shouldSample(random: () => number = Math.random): boolean {
  return random() < SAMPLE_RATE;
}

/**
 * Report a Core Web Vital to the first-party /api/vitals endpoint using
 * navigator.sendBeacon, falling back to fetch when unavailable.
 */
export function reportVitals(
  metric: Pick<NextWebVitalsMetric, "name" | "value"> & { rating?: string },
  pathname: string | null | undefined,
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!shouldSample()) {
    return;
  }

  const payload = shapeVitalsPayload(metric, pathname);
  const body = JSON.stringify(payload);

  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon("/api/vitals", blob);
    return;
  }

  void fetch("/api/vitals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Reporting must never break the page.
  });
}
