import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import type { LaTeXdiffService } from '@latex/latexdiff';
import type { DiffRunOutcome } from '@latex/latexdiff/types';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { OutputFileInfo, RoundIndexed, RunId } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';

import { createOutputFile } from '../support/ProgressControllerHarnesses';

const mocks = vi.hoisted(() => ({
  readRunOutputs: vi.fn(),
  runLatexdiffFromMetadata: vi.fn(),
}));

vi.mock('@latex/latexdiff/diffOperations', () => ({
  runLatexdiffFromMetadata: mocks.runLatexdiffFromMetadata,
}));

const { runLatexdiffForRun } = await import('@latex/latexdiff/runLatexdiff');

/**
 * The diff engine is mocked here, so the outcome is a placeholder: these
 * tests assert which outputs reached the engine, never what it returned.
 */
const EMPTY_OUTCOME: DiffRunOutcome = { results: [] };

const request = {
  runId: 'abc123' as RunId,
  workspaceRoot: '/workspace',
  runDiscovery: { readRunOutputs: mocks.readRunOutputs },
  generateBetweenRoundDiffs: false,
  latexdiff: { channel: 'test', service: {} as LaTeXdiffService },
  progress: { report: () => undefined },
} as const;

describe('runLatexdiffForRun', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await installPlatform();
    mocks.runLatexdiffFromMetadata.mockReturnValue(
      Effect.succeed(EMPTY_OUTCOME),
    );
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it.effect('diffs the outputs the run recorded', () =>
    Effect.gen(function* () {
      const rounds: RoundIndexed<OutputFileInfo> = {
        1: [createOutputFile({ round: 1 })],
      };
      mocks.readRunOutputs.mockReturnValue(Effect.succeed(rounds));

      yield* runLatexdiffForRun(request);

      expect(mocks.readRunOutputs).toHaveBeenCalledWith('abc123');
      expect(mocks.runLatexdiffFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ rounds }),
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  // #10635: the caller's channel covers the whole run, the read included.
  it.effect(
    'reports no diff operations, on the caller channel, when the run recorded no outputs',
    () =>
      Effect.gen(function* () {
        mocks.readRunOutputs.mockReturnValue(Effect.succeed({ 1: [] }));
        const logs = captureLogEntries();

        const outcome = yield* runLatexdiffForRun(request);

        expect(outcome.results).toEqual([]);
        expect(mocks.runLatexdiffFromMetadata).not.toHaveBeenCalled();
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
