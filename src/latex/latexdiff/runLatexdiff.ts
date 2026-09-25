/**
 * Host-neutral orchestration for a full latexdiff run.
 *
 * Reads the run's recorded round outputs from the session's fold (the
 * `output.produced` facts, via {@link LatexRunDiscoveryPort.readRunOutputs})
 * and runs the metadata-driven diff engine over them. That fold is the only
 * source: run storage is never rescanned and no workspace filename is parsed,
 * so a run with no recorded outputs has no diff operations. This is the
 * single source of truth shared by every host (VS Code command, desktop);
 * each host keeps only its own UX (progress chrome, prompts, result
 * rendering) and calls this with a {@link DiffProgressReporter}.
 */

import { Effect, type FileSystem, type Path } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import type { LatexdiffMathMarkupValue } from '@shared/constants/latexConfig';
import type { RunId } from '@shared/schemas';

import { runLatexdiffFromMetadata } from './diffOperations';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import type { LatexRunDiscoveryPort } from './runDiscovery';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
  LatexdiffRuntime,
} from './types';

interface RunLatexdiffForRunParams {
  /** The run whose recorded outputs are diffed. */
  readonly runId: RunId;
  /**
   * The calling session's workspace folder, carried as data: the cwd every
   * diff operation runs in and the root workspace-relative output paths
   * resolve against. `undefined` when no folder is open.
   */
  readonly workspaceRoot: string | undefined;
  /** Agent-owned read of the run's recorded outputs, injected by hosts. */
  readonly runDiscovery: LatexRunDiscoveryPort;
  readonly mathMarkup?: LatexdiffMathMarkupValue;
  readonly generateBetweenRoundDiffs: boolean;
  /** Host-supplied diff service + logger channel (see {@link LatexdiffRuntime}). */
  readonly latexdiff: LatexdiffRuntime;
  readonly progress: DiffProgressReporter;
}

export const runLatexdiffForRun = Effect.fn('runLatexdiffForRun')(
  function* (
    params: RunLatexdiffForRunParams,
  ): Effect.fn.Return<
    DiffRunOutcome,
    Error,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  > {
    const rounds = yield* params.runDiscovery.readRunOutputs(params.runId);

    // Hosts report an empty outcome as "no diff operations for this run".
    if (!Object.values(rounds).some((files) => files.length > 0)) {
      yield* Effect.logWarning(
        `No recorded outputs for run ${params.runId}; nothing to diff`,
      );
      return { results: [] };
    }

    return yield* runLatexdiffFromMetadata({
      rounds,
      workspaceRoot: params.workspaceRoot,
      mathMarkup: params.mathMarkup,
      generateBetweenRoundDiffs: params.generateBetweenRoundDiffs,
      latexdiff: params.latexdiff,
      progress: params.progress,
    });
  },
  // One channel for the whole run, so the read and the diff engine below
  // both land on the caller's channel.
  (effect, params) => withLogChannel(params.latexdiff.channel)(effect),
);
