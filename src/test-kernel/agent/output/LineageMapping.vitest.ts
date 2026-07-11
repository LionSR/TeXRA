import { describe, expect, it } from 'vitest';

import { traceFileLineage } from '@agent/output/lineageMapping';
import { createOutputState, ensureRoundData } from '@agent/output/outputState';
import type { ExecutionId } from '@shared/schemas';
import { createRunStorageLocation, getComparablePath } from '@utils/files';

describe('workflow output lineage mapping', () => {
  const executionId: ExecutionId = 'abc123';

  function runStorageFile(relativePath: string) {
    return createRunStorageLocation(
      `/run/${relativePath}`,
      relativePath,
      executionId,
    );
  }

  it('matches extracted documents by relative path before basename fallbacks', () => {
    const chapter1 = runStorageFile('inputs/chapter1/lemma.tex');
    const chapter2 = runStorageFile('inputs/chapter2/lemma.tex');
    const chapter1Output = runStorageFile('r0/inputs/chapter1/lemma.tex');
    const chapter2Output = runStorageFile('r0/inputs/chapter2/lemma.tex');

    const state = createOutputState();
    ensureRoundData(state, 0).outputs = [
      {
        source: 'inputs/chapter1/lemma.tex',
        round: 0,
        location: chapter1Output,
        lineage: null,
        diff: null,
      },
      {
        source: 'inputs/chapter2/lemma.tex',
        round: 0,
        location: chapter2Output,
        lineage: null,
        diff: null,
      },
    ];

    const mapping = traceFileLineage(state, [chapter1, chapter2], 0);

    expect(mapping.get(getComparablePath(chapter1Output))?.origin).toBe(
      chapter1,
    );
    expect(mapping.get(getComparablePath(chapter2Output))?.origin).toBe(
      chapter2,
    );
    expect(mapping.get(getComparablePath(chapter1Output))?.base).toBe(chapter1);
    expect(mapping.get(getComparablePath(chapter2Output))?.base).toBe(chapter2);
  });
});
