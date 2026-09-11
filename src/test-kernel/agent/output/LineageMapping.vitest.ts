import { describe, expect, it } from 'vitest';

import { traceFileLineage } from '@agent/implementations/flows/reflection/output/lineageMapping';
import {
  createOutputState,
  ensureRoundData,
} from '@agent/implementations/flows/reflection/output/outputState';
import { fileLocationDisplayPath, type RunId } from '@shared/schemas';
import { createRunStorageLocation } from '@utils/files/fileLocation';

describe('workflow output lineage mapping', () => {
  const runId = 'abc123' as RunId;

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

    const chapter1Entry = mapping.get(fileLocationDisplayPath(chapter1Output));
    expect(chapter1Entry?.origin).toBe(chapter1);
    expect(chapter1Entry?.base).toBe(chapter1);
    const chapter2Entry = mapping.get(fileLocationDisplayPath(chapter2Output));
    expect(chapter2Entry?.origin).toBe(chapter2);
    expect(chapter2Entry?.base).toBe(chapter2);
  });

  it('pairs previous-round outputs by exact basename even when names contain "_r"', () => {
    const report = runStorageFile('inputs/my_report.tex');
    const results = runStorageFile('inputs/my_results.tex');
    const prevReport = runStorageFile('r0/my_report.tex');
    const prevResults = runStorageFile('r0/my_results.tex');
    const currReport = runStorageFile('r1/my_report.tex');
    const currResults = runStorageFile('r1/my_results.tex');
    const output = (
      source: string,
      round: number,
      location: typeof report,
    ) => ({
      source,
      round,
      location,
      lineage: null,
      diff: null,
    });

    const state = createOutputState();
    ensureRoundData(state, 0).outputs = [
      output('inputs/my_report.tex', 0, prevReport),
      output('inputs/my_results.tex', 0, prevResults),
    ];
    ensureRoundData(state, 1).outputs = [
      output('inputs/my_report.tex', 1, currReport),
      output('inputs/my_results.tex', 1, currResults),
    ];

    const mapping = traceFileLineage(state, [report, results], 1);

    expect(mapping.get(fileLocationDisplayPath(currReport))?.prev).toBe(
      prevReport,
    );
    expect(mapping.get(fileLocationDisplayPath(currResults))?.prev).toBe(
      prevResults,
    );
  });
});
