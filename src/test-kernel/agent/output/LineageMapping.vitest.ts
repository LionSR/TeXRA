import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import {
  RunIdSchema,
  fileLocationDisplayPath,
} from '@texra-ai/harness/schemas';
import { createRunStorageLocation } from '@texra-ai/harness/host';
import { pairOutputsWithBases } from '@texra/agent/output/lineageMapping';

describe('document task output lineage mapping', () => {
  const runId = Schema.decodeUnknownSync(RunIdSchema)('abc123');

  function runStorageFile(relativePath: string) {
    return createRunStorageLocation(
      `/run/${relativePath}`,
      relativePath,
      runId,
    );
  }

  it('matches extracted documents by relative path before basename fallbacks', () => {
    const chapter1 = runStorageFile('inputs/chapter1/lemma.tex');
    const chapter2 = runStorageFile('inputs/chapter2/lemma.tex');
    const chapter1Output = runStorageFile('r0/inputs/chapter1/lemma.tex');
    const chapter2Output = runStorageFile('r0/inputs/chapter2/lemma.tex');

    const outputs = [
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

    const mapping = pairOutputsWithBases([chapter1, chapter2], outputs);

    const chapter1Entry = mapping.get(fileLocationDisplayPath(chapter1Output));
    expect(chapter1Entry?.origin).toBe(chapter1);
    expect(chapter1Entry?.base).toBe(chapter1);
    const chapter2Entry = mapping.get(fileLocationDisplayPath(chapter2Output));
    expect(chapter2Entry?.origin).toBe(chapter2);
    expect(chapter2Entry?.base).toBe(chapter2);
  });
});
