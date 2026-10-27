# Low-end Android perf lab

Lighthouse on a laptop hides main-thread and memory regressions that only
show on the phones responders carry. `npm run perf:lab`
(`scripts/perf-lab.mjs`) loads key pages in Chromium emulating a low-end
Android device and fails when the median exceeds budget.

## Device profile and budgets

Both live in the versioned file
[`perf/low-end-budgets.json`](../perf/low-end-budgets.json), each with a
`rationale`. Change a budget only in a PR that explains why.

- CPU: 6× slowdown (`Emulation.setCPUThrottlingRate`)
- Network: slow-4G (150 ms RTT, 1.6 Mbps down / 750 kbps up)
- Memory: `navigator.deviceMemory = 2`, V8 heap capped at 512 MB
- Viewport: 360×640 @2x, touch, mobile

Scenarios:

- `public-card` — `/card/<id>` cold load over slow-4G.
- `offline-card` — the same card primed online, then reloaded with the
  context offline so the service worker serves it.

Metrics per run:

- `longTaskCount` — tasks over 50 ms (`PerformanceObserver('longtask')`).
- `totalBlockingTimeMs` — sum of `duration − 50 ms` over long tasks.
- `jsHeapUsedMb` — `JSHeapUsedSize` from CDP `Performance.getMetrics`.

## Pass / fail

A metric fails when its **median** over `runs` (5) exceeds
`max × (1 + failMargin)`. `failMargin` defaults to 10% and can be overridden
with `PERF_FAIL_MARGIN`.

## Stability method

- 5 runs per scenario, each in a fresh browser context (no shared cache).
- The median is used for pass/fail, so one outlier can't flip the result.
- The run-to-run coefficient of variation (stddev / mean) is reported per
  metric; values above `maxCoefficientOfVariation` (5%) are flagged ⚠️ in the
  summary. CPU throttling is relative to the runner, so compare results from
  the same runner class (`ubuntu-latest`).
- A 2 s settle after `load` captures hydration tasks consistently.

## Traces

Each run writes a DevTools trace to `artifacts/perf-lab/<scenario>-run<N>.trace.json`
plus `results.json`. In CI (`.github/workflows/perf-lab.yml`) they're uploaded
as the `perf-lab-traces` artifact and linked from the job summary on the PR.
Open a trace in the DevTools Performance panel.

## Running locally

```bash
npm run build && npm run start &
npx playwright install chromium
BASE_URL=http://localhost:3000 npm run perf:lab
```

See also [perf-budget.md](./perf-budget.md) (payload budget) and
[lighthouse-ci-setup.md](./lighthouse-ci-setup.md).
