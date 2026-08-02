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

  it('skips invalid non-object entries', () => {
    expect(parseDiffResultEntries([null, 'not an entry', 1])).toEqual([]);
  });

  it('skips invalid object entries without diff-result fields', () => {
    expect(parseDiffResultEntries([{}, { foo: 'bar' }])).toEqual([]);
  });
});
