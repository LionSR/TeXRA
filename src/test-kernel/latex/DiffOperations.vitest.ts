import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import type { LaTeXdiffService } from '@latex/latexdiff';
import {
  runLatexdiffFromMetadata,
  runLatexdiffViaWorkspaceScan,
} from '@latex/latexdiff/diffOperations';
import type { LatexdiffRuntime } from '@latex/latexdiff/types';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import type { OutputFileInfo } from '@shared/schemas';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { installPlatform } from '@test/support/setupPlatform';
import { createWorkspaceLocation } from '@utils/files/fileLocation';

// #10635: diffOperations names the latexdiff runtime channel once for the
// whole run, so every entry its helpers write lands on that channel.
const CHANNEL = 'pinnedDiffChannel';

const progress = { report: () => undefined };

function runtimeWith(service: Partial<LaTeXdiffService>): LatexdiffRuntime {
  return { channel: CHANNEL, service: service as LaTeXdiffService };
}

describe('diffOperations diagnostics', () => {
  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  it.effect('logs each executed diff on the latexdiff runtime channel', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({
          workspacePath: '/workspace',
          config: { 'texra.logger.debugMode': true },
          files: {
            '/workspace/paper.tex': '\\documentclass{article}\n',
            '/workspace/r1/paper.tex': '\\documentclass{article}\n',
          },
        }),
      );
      const runDiffForRound = vi.fn(() =>
        Effect.succeed({
          success: true as const,
          diffPath: '/workspace/r1/paper_diff.tex',
          message: 'diff written',
        }),
      );
      const base = createWorkspaceLocation('/workspace/paper.tex', 'paper.tex');
      const revised = createWorkspaceLocation(
        '/workspace/r1/paper.tex',
        'r1/paper.tex',
      );
      const output: OutputFileInfo = {
        source: 'paper.tex',
        location: revised,
        round: 1,
        lineage: { original: base, diffBase: null },
        diff: null,
      };
      const logs = captureLogEntries();

      const outcome = yield* runLatexdiffFromMetadata({
        rounds: { 1: [output] },
        generateBetweenRoundDiffs: false,
        latexdiff: runtimeWith({ runDiffForRound }),
        progress,
      });

      expect(outcome.results).toEqual([
        expect.objectContaining({
          success: true,
          description: 'paper.tex (r1)',
        }),
      ]);
      expect(runDiffForRound).toHaveBeenCalledOnce();
      expect(
        logs.has('DEBUG', CHANNEL, 'Running round diff: paper.tex (r1)'),
      ).toBe(true);
    }).pipe(Effect.provide(effectDiagnosticsLayer)),
  );

  it.effect(
    'logs workspace-scan progress on the latexdiff runtime channel',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            workspacePath: '/workspace',
            config: { 'texra.logger.debugMode': true },
            files: { '/workspace/paper.tex': '\\documentclass{article}\n' },
          }),
        );
        const logs = captureLogEntries();

        const outcome = yield* runLatexdiffViaWorkspaceScan({
          agent: 'revise',
          model: 'claude-opus-4-8',
          inputFile: 'paper.tex',
          generateBetweenRoundDiffs: false,
          latexdiff: runtimeWith({}),
          progress,
        });

        // A bare source name matches no legacy/mid-era round layout, so the scan
        // reports the empty outcome instead of dispatching diff operations.
        expect(outcome).toEqual({ results: [] });
        expect(logs.has('DEBUG', CHANNEL, 'Input files: paper.tex')).toBe(true);
        expect(
          logs.has('DEBUG', CHANNEL, 'No matching outputs found for paper.tex'),
        ).toBe(true);
      }).pipe(Effect.provide(effectDiagnosticsLayer)),
  );
});
