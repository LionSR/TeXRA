import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { runLatexdiffForRun } from '@latex/latexdiff/diffOperations';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { RunId } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

describe('runLatexdiffForRun', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await installPlatform();
  });

  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  // #10635: the caller's channel covers the whole run, the read included.
  it.effect(
    'reports no diff operations, on the caller channel, when the run recorded no outputs',
    () =>
      Effect.gen(function* () {
        const readRunOutputs = vi.fn(() => Effect.succeed({ 1: [] }));
        const logs = captureLogEntries();

        const outcome = yield* runLatexdiffForRun({
          runId: 'abc123' as RunId,
          roots: testWorkspaceRoots(),
          runDiscovery: { readRunOutputs },
          channel: 'test',
          progress: { report: () => undefined },
        });

        expect(readRunOutputs).toHaveBeenCalledWith('abc123');
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
