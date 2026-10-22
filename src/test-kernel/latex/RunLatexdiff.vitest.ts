import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import {
  latexdiffPairs,
  runLatexdiffForRun,
} from '@latex/latexdiff/diffOperations';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { fileLocationDisplayPath, type RunId } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
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

describe('runLatexdiffForRun', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await installPlatform();
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  // #10635: the caller's channel covers the whole run.
  it.effect(
    'reports no diff operations, on the caller channel, when the run recorded no outputs',
    () =>
      Effect.gen(function* () {
        const logs = captureLogEntries();

        const outcome = yield* runLatexdiffForRun({
          runId: 'abc123' as RunId,
          roots: testWorkspaceRoots(),
          rounds: { 1: [] },
          channel: 'test',
          progress: { report: () => undefined },
        });

        expect(outcome.results).toEqual([]);
        expect(
          logs.has(
            'WARN',
            'test',
            'No recorded outputs for run abc123; nothing to diff',
          ),
        ).toBe(true);
      }).pipe(
        Effect.provide(effectDiagnosticsLayer('Trace')),
        Effect.provide(nodePlatformLayer),
      ),
  );
});
