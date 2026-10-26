import { describe, expect, it } from 'vitest';
import { latexdiffPairs } from '@latex/latexdiff/diffOperations';
import { fileLocationDisplayPath, type RunId } from '@shared/schemas';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import { createRunStorageLocation } from '@utils/files/fileLocation';

describe('latexdiffPairs', () => {
  const runId = 'abc123' as RunId;
  const file = (relativePath: string) =>
    createRunStorageLocation(`/run/${relativePath}`, relativePath, runId);
  const output = (round: number, source: string): OutputFileInfo => ({
    source,
    round,
    location: file(`r${round}/${source}`),
    lineage: { original: null, diffBase: file(source) },
    diff: null,
  });

  // Two documents sharing a basename were once paired by it: `b/main.tex`
  // diffed against `r0/a/main.tex`, and `a/main.tex` got no between-round
  // diff.
  it('pairs each output with its recorded base and its own previous-round document', () => {
    const previous = [output(0, 'a/main.tex'), output(0, 'b/main.tex')];
    const current = [output(1, 'a/main.tex'), output(1, 'b/main.tex')];

    const pairs = latexdiffPairs(current, previous).map((pair) => [
      fileLocationDisplayPath(pair.revised.location),
      fileLocationDisplayPath(pair.base),
      pair.baseRound,
    ]);

    expect(pairs).toStrictEqual([
      ['r1/a/main.tex', 'a/main.tex', null],
      ['r1/b/main.tex', 'b/main.tex', null],
      ['r1/a/main.tex', 'r0/a/main.tex', 0],
      ['r1/b/main.tex', 'r0/b/main.tex', 0],
    ]);
  });
});
