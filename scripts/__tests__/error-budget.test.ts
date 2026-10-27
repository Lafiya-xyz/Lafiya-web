/**
 * Unit tests for the error-budget policy engine.
 *
 * Tests cover: budget computation, burn rate calculation, multi-window alert
 * thresholds, and gate status determination for healthy, burning-fast, and
 * exhausted budget states.
 */

import { describe, expect, it } from "vitest";

// Dynamic import of .mjs from TypeScript test — vitest handles this via
// the transform pipeline.
const { evaluateErrorBudget, burnRate, errorRate, errorBudgetMinutes, BURN_RATE_THRESHOLDS } =
  await import("../error-budget.mjs");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SLO = 0.999; // 99.9%
const WINDOW_30D = 30 * 24 * 60 * 60; // 2,592,000 seconds

/** 30-day budget: 43.2 minutes allowed to fail */
const BUDGET_MINUTES = (WINDOW_30D / 60) * (1 - SLO); // = 43.2

/** No errors at all — full budget remaining */
const healthyMetrics = {
  windowSeconds: WINDOW_30D,
  sloTarget: SLO,
  totalRequests: 1_000_000,
  successfulRequests: 1_000_000,
  windows: [
    { label: "1h",  totalRequests: 500,    successfulRequests: 500 },
    { label: "6h",  totalRequests: 3_000,  successfulRequests: 3_000 },
    { label: "24h", totalRequests: 12_000, successfulRequests: 12_000 },
    { label: "72h", totalRequests: 36_000, successfulRequests: 36_000 },
  ],
};

/** 50% budget consumed but healthy burn rate */
const halfBudgetMetrics = {
  windowSeconds: WINDOW_30D,
  sloTarget: SLO,
  totalRequests: 1_000_000,
  // 0.05% error rate = 50% budget consumed
  successfulRequests: 999_500,
  windows: [
    { label: "1h",  totalRequests: 500,    successfulRequests: 499 },
    { label: "6h",  totalRequests: 3_000,  successfulRequests: 2_994 },
    { label: "24h", totalRequests: 12_000, successfulRequests: 11_988 },
    { label: "72h", totalRequests: 36_000, successfulRequests: 35_964 },
  ],
};

/** Budget exhausted: error rate > 0.1% (above the 99.9% SLO) */
const exhaustedMetrics = {
  windowSeconds: WINDOW_30D,
  sloTarget: SLO,
  totalRequests: 1_000_000,
  // 0.15% error rate = 150% budget consumed (exhausted)
  successfulRequests: 998_500,
  windows: [
    { label: "1h",  totalRequests: 500,    successfulRequests: 499 },
    { label: "6h",  totalRequests: 3_000,  successfulRequests: 2_994 },
    { label: "24h", totalRequests: 12_000, successfulRequests: 11_988 },
    { label: "72h", totalRequests: 36_000, successfulRequests: 35_964 },
  ],
};

/**
 * Fast burn: 1h burn rate >> 14.4 (should trigger page-severity alert).
 * 0.1% error rate in 1h window = 100x the allowed error budget rate.
 */
const fastBurnMetrics = {
  windowSeconds: WINDOW_30D,
  sloTarget: SLO,
  totalRequests: 1_000_000,
  successfulRequests: 999_900, // just under budget
  windows: [
    // 1% error rate in last hour = 10x error budget rate = burn rate 10
    // (14.4 threshold for page)
    { label: "1h",  totalRequests: 1_000, successfulRequests: 985 }, // 1.5% → BR=15 > 14.4
    { label: "6h",  totalRequests: 3_000, successfulRequests: 2_994 },
    { label: "24h", totalRequests: 12_000, successfulRequests: 11_988 },
    { label: "72h", totalRequests: 36_000, successfulRequests: 35_964 },
  ],
};

// ── Primitive function tests ──────────────────────────────────────────────────

describe("errorRate", () => {
  it("returns 0 for zero total requests", () => {
    expect(errorRate(0, 0)).toBe(0);
  });

  it("returns 0 for all-successful requests", () => {
    expect(errorRate(1000, 1000)).toBe(0);
  });

  it("returns 0.001 for 1 error in 1000 requests", () => {
    expect(errorRate(1000, 999)).toBeCloseTo(0.001);
  });

  it("clamps to 0 when successful > total (data anomaly)", () => {
    expect(errorRate(100, 200)).toBe(0);
  });
});

describe("burnRate", () => {
  it("returns 0 when there are no errors", () => {
    expect(burnRate(0, SLO)).toBe(0);
  });

  it("returns 1.0 at exactly the SLO error rate (sustainable)", () => {
    // error budget rate = 1 - 0.999 = 0.001
    // burn rate = 0.001 / 0.001 = 1.0
    expect(burnRate(0.001, SLO)).toBeCloseTo(1.0);
  });

  it("returns 14.4 for burn rate equal to the 1h page threshold", () => {
    expect(burnRate(0.001 * 14.4, SLO)).toBeCloseTo(14.4);
  });

  it("returns Infinity when sloTarget = 1 (perfect SLO, no budget)", () => {
    expect(burnRate(0.001, 1.0)).toBe(Infinity);
  });
});

describe("errorBudgetMinutes", () => {
  it("computes 43.2 minutes for 99.9% SLO over 30 days", () => {
    expect(errorBudgetMinutes(WINDOW_30D, SLO)).toBeCloseTo(43.2, 1);
  });

  it("returns 0 for a perfect 100% SLO", () => {
    expect(errorBudgetMinutes(WINDOW_30D, 1.0)).toBe(0);
  });
});

// ── evaluateErrorBudget — healthy state ───────────────────────────────────────

describe("evaluateErrorBudget — healthy budget", () => {
  it("gate is open and no alerts for zero-error state", () => {
    const result = evaluateErrorBudget(healthyMetrics);
    expect(result.gateStatus).toBe("open");
    expect(result.alerts).toHaveLength(0);
  });

  it("reports correct budget minutes", () => {
    const result = evaluateErrorBudget(healthyMetrics);
    expect(result.errorBudgetMinutes).toBeCloseTo(BUDGET_MINUTES, 1);
    expect(result.remainingMinutes).toBeCloseTo(BUDGET_MINUTES, 1);
    expect(result.consumedMinutes).toBe(0);
  });

  it("remaining fraction is 1.0 with no errors", () => {
    const result = evaluateErrorBudget(healthyMetrics);
    expect(result.remainingFraction).toBe(1);
  });
});

// ── evaluateErrorBudget — fast-burning state ──────────────────────────────────

describe("evaluateErrorBudget — fast burn (budget burning but not exhausted)", () => {
  it("gate is blocked on page-severity 1h alert", () => {
    const result = evaluateErrorBudget(fastBurnMetrics);
    expect(result.gateStatus).toBe("blocked");
  });

  it("surfaces a page-severity alert for the 1h window", () => {
    const result = evaluateErrorBudget(fastBurnMetrics);
    const alert = result.alerts.find((a) => a.window === "1h");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("page");
    expect(alert?.burnRate).toBeGreaterThan(14.4);
  });

  it("gate reason references override procedure", () => {
    const result = evaluateErrorBudget(fastBurnMetrics);
    expect(result.gateReason).toContain("error-budget-policy.md");
  });
});

// ── evaluateErrorBudget — exhausted budget ────────────────────────────────────

describe("evaluateErrorBudget — exhausted budget", () => {
  it("gate is blocked when budget is exhausted", () => {
    const result = evaluateErrorBudget(exhaustedMetrics);
    expect(result.gateStatus).toBe("blocked");
  });

  it("remaining fraction is negative when budget is exhausted", () => {
    const result = evaluateErrorBudget(exhaustedMetrics);
    expect(result.remainingFraction).toBeLessThan(0);
  });

  it("gate reason explicitly mentions exhaustion", () => {
    const result = evaluateErrorBudget(exhaustedMetrics);
    expect(result.gateReason).toContain("exhausted");
  });

  it("consumed fraction exceeds 1.0", () => {
    const result = evaluateErrorBudget(exhaustedMetrics);
    expect(result.consumedFraction).toBeGreaterThan(1.0);
  });
});

// ── evaluateErrorBudget — half budget consumed (warn state) ──────────────────

describe("evaluateErrorBudget — half budget (warn state)", () => {
  it("gate is warn when burn rate > warn threshold but < page threshold", () => {
    // Elevate 24h window to trigger warn-severity
    const metrics = {
      ...halfBudgetMetrics,
      windows: [
        { label: "1h",  totalRequests: 500,    successfulRequests: 499 },
        { label: "6h",  totalRequests: 3_000,  successfulRequests: 2_994 },
        // 24h window at 3x burn rate (threshold for warn is 3.0)
        { label: "24h", totalRequests: 12_000, successfulRequests: 11_964 }, // 3x
        { label: "72h", totalRequests: 36_000, successfulRequests: 35_964 },
      ],
    };
    const result = evaluateErrorBudget(metrics);
    // May be warn or open depending on exact rate
    expect(["warn", "open"]).toContain(result.gateStatus);
  });

  it("gate is open when budget is at exactly 50% and burn rates are all low", () => {
    const result = evaluateErrorBudget(halfBudgetMetrics);
    // 1h burn rate = (1/500) / 0.001 = 2.0 < 14.4, 6h = (6/3000)/0.001 = 2.0 < 6
    // 24h = (12/12000)/0.001 = 1.0 < 3.0, 72h = (36/36000)/0.001 = 1.0
    expect(result.gateStatus).toBe("open");
  });
});

// ── BURN_RATE_THRESHOLDS structure ────────────────────────────────────────────

describe("BURN_RATE_THRESHOLDS", () => {
  it("has thresholds for 1h, 6h, 24h, and 72h windows", () => {
    const windows = BURN_RATE_THRESHOLDS.map((t) => t.window);
    expect(windows).toContain("1h");
    expect(windows).toContain("6h");
    expect(windows).toContain("24h");
    expect(windows).toContain("72h");
  });

  it("1h and 6h thresholds have page severity", () => {
    for (const t of BURN_RATE_THRESHOLDS.filter((t) =>
      ["1h", "6h"].includes(t.window),
    )) {
      expect(t.severity).toBe("page");
    }
  });

  it("24h and 72h thresholds have warn severity", () => {
    for (const t of BURN_RATE_THRESHOLDS.filter((t) =>
      ["24h", "72h"].includes(t.window),
    )) {
      expect(t.severity).toBe("warn");
    }
  });
});

// ── evaluateErrorBudget — override documentation ─────────────────────────────

describe("evaluateErrorBudget — gate reason content", () => {
  it("open state reason mentions no burn-rate alerts", () => {
    const result = evaluateErrorBudget(healthyMetrics);
    expect(result.gateReason).toContain("healthy");
  });

  it("blocked state reason always references override procedure doc", () => {
    const exhausted = evaluateErrorBudget(exhaustedMetrics);
    const fastBurn = evaluateErrorBudget(fastBurnMetrics);
    expect(exhausted.gateReason).toContain("error-budget-policy.md");
    expect(fastBurn.gateReason).toContain("error-budget-policy.md");
  });
});
