import { describe, expect, it } from 'vitest';

import {
  findRatchetViolations,
  summarizeKnipIssues,
} from '../../../scripts/check-dead-code-ratchet.mjs';

describe('check-dead-code-ratchet summarizeKnipIssues', () => {
  it('sums files/exports/types/duplicates across all knip issue entries', () => {
    const issues = [
      {
        file: 'a.ts',
        files: [{ name: 'a.ts' }],
        exports: [],
        types: [],
        duplicates: [],
      },
      {
        file: 'b.ts',
        files: [],
        exports: [{ name: 'foo' }, { name: 'bar' }],
        types: [{ name: 'Baz' }],
        duplicates: [],
      },
      {
        file: 'c.ts',
        files: [],
        exports: [],
        types: [],
        duplicates: [[{ name: 'x' }, { name: 'y' }]],
      },
    ];

    expect(summarizeKnipIssues(issues)).toEqual({
      unusedFiles: 1,
      unusedExports: 2,
      unusedTypes: 1,
      duplicateExports: 1,
    });
  });

  it('treats missing per-metric arrays as zero, matching knip omitting empty keys', () => {
    const issues = [{ file: 'a.ts' }];

    expect(summarizeKnipIssues(issues)).toEqual({
      unusedFiles: 0,
      unusedExports: 0,
      unusedTypes: 0,
      duplicateExports: 0,
    });
  });

  it('returns all-zero counts for an empty issue list', () => {
    expect(summarizeKnipIssues([])).toEqual({
      unusedFiles: 0,
      unusedExports: 0,
      unusedTypes: 0,
      duplicateExports: 0,
    });
  });
});

describe('check-dead-code-ratchet findRatchetViolations', () => {
  const baseline = {
    unusedFiles: 2,
    unusedExports: 385,
    unusedTypes: 299,
    duplicateExports: 3,
  };

  it('reports no violations when counts stay at or below the baseline', () => {
    expect(findRatchetViolations(baseline, baseline)).toEqual([]);
    expect(
      findRatchetViolations(
        {
          unusedFiles: 0,
          unusedExports: 0,
          unusedTypes: 0,
          duplicateExports: 0,
        },
        baseline,
      ),
    ).toEqual([]);
  });

  it('flags only the metrics that increase past the baseline', () => {
    const current = { ...baseline, unusedExports: 386, unusedTypes: 300 };

    expect(findRatchetViolations(current, baseline)).toEqual([
      { metric: 'unusedExports', currentCount: 386, baselineCount: 385 },
      { metric: 'unusedTypes', currentCount: 300, baselineCount: 299 },
    ]);
  });

  it('does not flag a decrease below the baseline', () => {
    const current = { ...baseline, unusedFiles: 1 };

    expect(findRatchetViolations(current, baseline)).toEqual([]);
  });
});
