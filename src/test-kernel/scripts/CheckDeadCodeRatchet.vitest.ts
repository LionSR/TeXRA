import { describe, expect, it } from 'vitest';

const ratchet = await import(
  // @ts-expect-error This internal JavaScript script intentionally has no declaration file.
  '../../../scripts/check-dead-code-ratchet-core.mjs'
);
const {
  compareFindings,
  countByCategory,
  diffFindings,
  extractFindings,
  findingKey,
  parseKnipIssues,
  readBaseline,
} = ratchet;
type KnipFinding = {
  file: string;
  category: 'files' | 'exports' | 'types' | 'duplicates';
  name: string;
};

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

describe('check-dead-code-ratchet extractFindings', () => {
  it('flattens files/exports/types/duplicates into one finding per symbol, keyed by (file, category, name)', () => {
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

    expect(extractFindings(issues)).toEqual([
      { file: 'a.ts', category: 'files', name: 'a.ts' },
      { file: 'b.ts', category: 'exports', name: 'foo' },
      { file: 'b.ts', category: 'exports', name: 'bar' },
      { file: 'b.ts', category: 'types', name: 'Baz' },
      { file: 'c.ts', category: 'duplicates', name: 'x,y' },
    ]);
  });

  it('never keys a finding by line number, only by (file, category, name)', () => {
    const issue = {
      file: 'a.ts',
      files: [],
      exports: [{ name: 'foo', line: 10, col: 1, pos: 99 }],
      types: [],
      duplicates: [],
    };

    expect(extractFindings([issue])).toEqual([
      { file: 'a.ts', category: 'exports', name: 'foo' },
    ]);
  });

  it('sorts a duplicate group by member name so key order does not depend on knip emission order', () => {
    const groupA = { duplicates: [[{ name: 'b' }, { name: 'a' }]] };
    const groupB = { duplicates: [[{ name: 'a' }, { name: 'b' }]] };

    expect(findingKey(extractFindings([{ file: 'x.ts', ...groupA }])[0])).toBe(
      findingKey(extractFindings([{ file: 'x.ts', ...groupB }])[0]),
    );
  });

  it('treats missing per-category arrays as no findings, matching knip omitting empty keys', () => {
    expect(extractFindings([{ file: 'a.ts' }])).toEqual([]);
  });

  it('returns no findings for an empty issue list', () => {
    expect(extractFindings([])).toEqual([]);
  });

  it('extracts one finding per symbol from real captured knip --reporter json output', () => {
    const { issues } = JSON.parse(REAL_KNIP_STDOUT);

    expect(countByCategory(extractFindings(issues))).toEqual({
      files: 2,
      exports: 3,
      types: 2,
      duplicates: 1,
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

  // Each of these must throw the contextual error (never a raw TypeError or a
  // silent default of zero issues) when the `issues` array is unusable.
  it.each([
    { label: '`issues` is missing', stdout: JSON.stringify({}) },
    {
      label: '`issues` is present but not an array',
      stdout: JSON.stringify({ issues: { oops: true } }),
    },
    { label: 'stdout parses to null', stdout: 'null' },
  ])('throws when $label', ({ stdout }) => {
    expect(() => parseKnipIssues(stdout, '')).toThrow(
      /knip JSON output has no `issues` array/,
    );
  });
});

describe('check-dead-code-ratchet readBaseline', () => {
  it('returns the findings array from a well-formed baseline document', () => {
    const findings = [{ file: 'a.ts', category: 'exports', name: 'foo' }];

    expect(readBaseline(JSON.stringify({ semantics: 'x', findings }))).toEqual(
      findings,
    );
  });

  it('throws when the baseline document has no findings array', () => {
    expect(() => readBaseline(JSON.stringify({ semantics: 'x' }))).toThrow(
      /missing a "findings" array/,
    );
  });
});

describe('check-dead-code-ratchet diffFindings', () => {
  const baseline: KnipFinding[] = [
    { file: 'a.ts', category: 'exports', name: 'foo' },
    { file: 'b.ts', category: 'types', name: 'Bar' },
  ];

  it('reports no new or resolved findings when current matches baseline exactly', () => {
    expect(diffFindings(baseline, baseline)).toEqual({
      newFindings: [],
      resolvedFindings: [],
    });
  });

  it('flags a finding present in current but absent from the baseline as new, by identity not count', () => {
    // Same total count as baseline (2), but a different export replaced
    // `foo` -- a pure count comparison would miss this entirely.
    const current: KnipFinding[] = [
      { file: 'a.ts', category: 'exports', name: 'newlyUnused' },
      { file: 'b.ts', category: 'types', name: 'Bar' },
    ];

    expect(diffFindings(current, baseline)).toEqual({
      newFindings: [{ file: 'a.ts', category: 'exports', name: 'newlyUnused' }],
      resolvedFindings: [{ file: 'a.ts', category: 'exports', name: 'foo' }],
    });
  });

  it('reports a baseline entry as resolved (but does not fail) when it disappears from current', () => {
    const current: KnipFinding[] = [
      { file: 'b.ts', category: 'types', name: 'Bar' },
    ];

    expect(diffFindings(current, baseline)).toEqual({
      newFindings: [],
      resolvedFindings: [{ file: 'a.ts', category: 'exports', name: 'foo' }],
    });
  });

  it('sorts both new and resolved findings by file, then category, then name', () => {
    const current: KnipFinding[] = [
      { file: 'z.ts', category: 'exports', name: 'z' },
      { file: 'a.ts', category: 'exports', name: 'a' },
    ];

    expect(diffFindings(current, []).newFindings).toEqual(
      [...current].sort(compareFindings),
    );
  });
});
