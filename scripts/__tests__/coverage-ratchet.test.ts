import { describe, it, expect } from 'vitest';
import {
  compareCoverage,
  mergeBaseline,
  type CoverageBaseline,
} from '../coverage-ratchet';

const baseline: CoverageBaseline = {
  directories: {
    'lib/emergency': { lines: 95, branches: 92 },
    'lib/attestation': { lines: 91, branches: 90 },
  },
};

describe('compareCoverage', () => {
  it('passes when coverage meets or exceeds the baseline', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 95, branches: 92 },
        'lib/attestation': { lines: 93, branches: 91 },
      },
    };

    const result = compareCoverage(current, baseline);

    expect(result.ok).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  it('fails when lines coverage drops below the baseline', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 94, branches: 92 },
        'lib/attestation': { lines: 91, branches: 90 },
      },
    };

    const result = compareCoverage(current, baseline);

    expect(result.ok).toBe(false);
    expect(result.regressions).toEqual([
      { directory: 'lib/emergency', metric: 'lines', baseline: 95, current: 94 },
    ]);
  });

  it('fails when branches coverage drops below the baseline', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 95, branches: 92 },
        'lib/attestation': { lines: 91, branches: 89 },
      },
    };

    const result = compareCoverage(current, baseline);

    expect(result.ok).toBe(false);
    expect(result.regressions).toEqual([
      { directory: 'lib/attestation', metric: 'branches', baseline: 90, current: 89 },
    ]);
  });

  it('treats a missing directory in current coverage as a regression', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 95, branches: 92 },
      },
    };

    const result = compareCoverage(current, baseline);

    expect(result.ok).toBe(false);
    expect(result.regressions).toEqual([
      { directory: 'lib/attestation', metric: 'lines', baseline: 91, current: 0 },
      { directory: 'lib/attestation', metric: 'branches', baseline: 90, current: 0 },
    ]);
  });

  it('ignores directories that are not tracked in the baseline', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 95, branches: 92 },
        'lib/attestation': { lines: 91, branches: 90 },
        'lib/stellar': { lines: 10, branches: 5 },
      },
    };

    const result = compareCoverage(current, baseline);

    expect(result.ok).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });
});

describe('mergeBaseline', () => {
  it('raises the baseline when coverage improves', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 97, branches: 94 },
        'lib/attestation': { lines: 91, branches: 90 },
      },
    };

    const merged = mergeBaseline(baseline, current);

    expect(merged.directories['lib/emergency']).toEqual({ lines: 97, branches: 94 });
    expect(merged.directories['lib/attestation']).toEqual({ lines: 91, branches: 90 });
  });

  it('never lowers the baseline when coverage regresses', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 90, branches: 88 },
        'lib/attestation': { lines: 91, branches: 90 },
      },
    };

    const merged = mergeBaseline(baseline, current);

    expect(merged.directories['lib/emergency']).toEqual({ lines: 95, branches: 92 });
  });

  it('adds newly tracked directories from current coverage', () => {
    const current: CoverageBaseline = {
      directories: {
        'lib/emergency': { lines: 95, branches: 92 },
        'lib/attestation': { lines: 91, branches: 90 },
        'lib/stellar': { lines: 93, branches: 91 },
      },
    };

    const merged = mergeBaseline(baseline, current);

    expect(merged.directories['lib/stellar']).toEqual({ lines: 93, branches: 91 });
  });
});
