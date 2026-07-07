import { describe, expect, it } from 'vitest';

import {
  findRatchetViolations,
  parseKnipIssues,
  summarizeKnipIssues,
} from '../../../scripts/check-dead-code-ratchet.mjs';

// Captured verbatim from a real `knip --reporter json` run against this repo
// (knip 6.24.0, `--include files,exports,types,duplicates`) and trimmed to a
// representative subset of entries. This confirms the real reporter shape:
// the top-level object has exactly one key, `issues`, and each issue entry
// nests its own `files`/`exports`/`types`/`duplicates` arrays — there is no
// separate top-level `files` array for wholly-unused files.
const REAL_KNIP_STDOUT = JSON.stringify({
  issues: [
    {
      file: 'src/test-kernel/support/setupFakePlatform.ts',
      duplicates: [],
      exports: [],
      files: [{ name: 'src/test-kernel/support/setupFakePlatform.ts' }],
      types: [],
    },
    {
      file: 'packages/trace-viewer/vite.standalone.config.ts',
      duplicates: [],
      exports: [],
      files: [{ name: 'packages/trace-viewer/vite.standalone.config.ts' }],
      types: [],
    },
    {
      file: 'src/auth/serverKeys/ServerSideKeyService.ts',
      duplicates: [],
      exports: [
        { name: 'USE_INCLUDED_ACCESS_KEY', line: 47, col: 14, pos: 1491 },
      ],
      files: [],
      types: [],
    },
    {
      file: 'src/test-kernel/support/FakePlatform.ts',
      duplicates: [],
      exports: [
        { name: 'FakeWorkspaceProvider', line: 429, col: 14, pos: 12849 },
        { name: 'FakeStorageProvider', line: 450, col: 14, pos: 13498 },
      ],
      files: [],
      types: [
        { name: 'RecordingLogLevel', line: 28, col: 13, pos: 1023 },
        { name: 'RecordingLogEntry', line: 30, col: 18, pos: 1098 },
      ],
    },
    {
      file: 'src/shared/schemas/goal.ts',
      duplicates: [
        [
          { name: 'goalElapsedMs', line: 53, col: 17, pos: 1751 },
          { name: 'goalDurationMs', line: 62, col: 14, pos: 2079 },
        ],
      ],
      exports: [],
      files: [],
      types: [],
    },
  ],
});

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

  it('sums counts correctly against real captured knip --reporter json output', () => {
    const { issues } = JSON.parse(REAL_KNIP_STDOUT);

    expect(summarizeKnipIssues(issues)).toEqual({
      unusedFiles: 2,
      unusedExports: 3,
      unusedTypes: 2,
      duplicateExports: 1,
    });
  });
});

describe('check-dead-code-ratchet parseKnipIssues', () => {
  it('extracts issues from real captured knip --reporter json output', () => {
    const issues = parseKnipIssues(REAL_KNIP_STDOUT, '');

    expect(issues).toHaveLength(5);
    expect(issues[0]).toMatchObject({
      file: 'src/test-kernel/support/setupFakePlatform.ts',
    });
  });

  it('throws with stdout/stderr context when stdout is not parseable JSON', () => {
    expect(() => parseKnipIssues('not json', 'some stderr')).toThrow(
      'knip did not produce parseable JSON output',
    );
  });

  it('throws instead of silently defaulting to zero issues when `issues` is missing', () => {
    expect(() => parseKnipIssues(JSON.stringify({}), '')).toThrow(
      /knip JSON output has no `issues` array/,
    );
  });

  it('throws when `issues` is present but not an array', () => {
    expect(() =>
      parseKnipIssues(JSON.stringify({ issues: { oops: true } }), ''),
    ).toThrow(/knip JSON output has no `issues` array/);
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
