import { describe, expect, it } from 'vitest';

import {
  DiffResultDisplaySchema,
  parseDiffResultEntries,
} from '@shared/schemas';

const canonicalDiffResult = {
  status: 'success',
  runId: 'abcdef',
  baseLocation: {
    kind: 'workspace',
    absolutePath: '/repo/main.tex',
    relativePath: 'main.tex',
  },
  baseRound: 1,
  revised: {
    source: 'main.tex',
    location: {
      kind: 'runStorage',
      absolutePath: '/tmp/texra/abcdef/r2/main.tex',
      relativePath: 'r2/main.tex',
      executionId: 'abcdef',
    },
    round: 2,
    lineage: {
      original: {
        kind: 'workspace',
        absolutePath: '/repo/src/main.tex',
        relativePath: 'src/main.tex',
      },
      diffBase: {
        kind: 'workspace',
        absolutePath: '/repo/main.tex',
        relativePath: 'main.tex',
      },
      diffFile: {
        kind: 'external',
        absolutePath: '/tmp/texra/abcdef/diff/main-diff.tex',
      },
    },
    diff: null,
  },
  diffLocation: {
    kind: 'external',
    absolutePath: '/tmp/texra/abcdef/diff/main-diff.tex',
  },
} as const;

const canonicalDisplay = {
  baseFile: '/repo/main.tex',
  revisedFile: '/tmp/texra/abcdef/r2/main.tex',
  diffFile: '/tmp/texra/abcdef/diff/main-diff.tex',
  displayName: 'main.tex',
  baseRound: 1,
  revisedRound: 2,
  status: 'success',
  message: undefined,
  runId: 'abcdef',
};

describe('DiffResult transforms', () => {
  it('derives display data from the canonical schema', () => {
    expect(DiffResultDisplaySchema.parse(canonicalDiffResult)).toEqual(
      canonicalDisplay,
    );
  });

  it('parses canonical entries through the public parser', () => {
    expect(parseDiffResultEntries([canonicalDiffResult])).toEqual([
      canonicalDisplay,
    ]);
  });

  it('normalizes legacy entries through the canonical transform path', () => {
    const [entry] = parseDiffResultEntries([
      {
        locations: {
          base: { absolutePath: '/repo/current/main.tex' },
          revised: { absolutePath: '/repo/current/main-revised.tex' },
          diff: { absolutePath: '/repo/current/main-diff.tex' },
        },
        basePath: '/repo/stale/base.tex',
        revisedPath: '/repo/stale/revised.tex',
        diffPath: '/repo/stale/diff.tex',
        baseLabel: 'main.tex [r4]',
        revisedLabel: '[r5]',
        originalFileName: 'original-main.tex',
        status: 'success',
        message: 'generated',
        runId: 'legacy-run',
      },
    ]);

    expect(entry).toEqual({
      baseFile: '/repo/current/main.tex',
      revisedFile: '/repo/current/main-revised.tex',
      diffFile: '/repo/current/main-diff.tex',
      displayName: 'original-main.tex',
      baseRound: 4,
      revisedRound: 5,
      status: 'success',
      message: 'generated',
      runId: 'legacy-run',
    });
  });

  it('preserves legacy status fallback and explicit round precedence', () => {
    const [entry] = parseDiffResultEntries([
      {
        basePath: '/repo/base.tex',
        revisedPath: '/repo/revised.tex',
        diffPath: '/repo/diff.tex',
        baseLabel: 'base-label.tex [r1]',
        revisedLabel: '[r2]',
        baseRound: 7,
        revisedRound: 8,
        status: 'unknown',
      },
    ]);

    expect(entry).toMatchObject({
      baseFile: '/repo/base.tex',
      revisedFile: '/repo/revised.tex',
      diffFile: '/repo/diff.tex',
      displayName: 'base-label.tex',
      baseRound: 7,
      revisedRound: 8,
      status: 'error',
    });
  });

  it('preserves path-qualified legacy display labels verbatim', () => {
    const entries = parseDiffResultEntries([
      {
        basePath: '/repo/base.tex',
        revisedPath: '/repo/revised.tex',
        originalFileName: 'chapters/intro.tex',
      },
      {
        basePath: '/repo/base.tex',
        revisedPath: '/repo/revised.tex',
        baseLabel: 'sections/method.tex [r3]',
      },
    ]);

    expect(entries.map((entry) => entry.displayName)).toEqual([
      'chapters/intro.tex',
      'sections/method.tex',
    ]);
  });

  it('falls back to the base filename for legacy display names', () => {
    const [entry] = parseDiffResultEntries([
      {
        basePath: '/repo/fallback.tex',
        revisedPath: '/repo/revised.tex',
      },
    ]);

    expect(entry?.displayName).toBe('fallback.tex');
    expect(entry?.baseRound).toBeNull();
    expect(entry?.revisedRound).toBe(0);
  });

  it('skips invalid non-object entries', () => {
    expect(parseDiffResultEntries([null, 'not an entry', 1])).toEqual([]);
  });

  it('skips invalid object entries without diff-result fields', () => {
    expect(
      parseDiffResultEntries([{}, { foo: 'bar' }, { revisedLabel: '[r5]' }]),
    ).toEqual([]);
  });
});
