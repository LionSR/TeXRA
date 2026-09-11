/**
 * Host-neutral orchestration for a full latexdiff run.
 *
 * Resolves which round outputs to diff: preferring caller-supplied metadata,
 * then a run-id-scoped run-dir scan, then agent/model/input auto-discovery —
 * and dispatches to the metadata-driven or workspace-scan diff engine. This is
 * the single source of truth shared by every host (VS Code command, CLI,
 * desktop); each host keeps only its own UX (progress chrome, prompts, result
 * rendering) and calls this with a {@link DiffProgressReporter}.
 */

import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  RunIdSchema,
  OutputFileInfoSchema,
  roundIndexedRecord,
} from '@shared/schemas';
import type {
  RunId,
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RoundIndexed,
} from '@shared/schemas';

import {
  runLatexdiffFromMetadata,
  runLatexdiffViaWorkspaceScan,
} from './diffOperations';
import { discoverLatestRunOutputs } from './outputDiscovery';
import {
  scanRunDirForOutputs,
  type RunOutputFilesystem,
} from './runOutputFiles';
import type { LatexRunDiscoveryPort } from './runDiscovery';
import type { MathMarkupOption } from './mathMarkup';
import type {
  DiffProgressReporter,
  DiffRunOutcome,
  LatexdiffRuntime,
} from './types';

/**
 * Validate a command payload's round outputs against the canonical record.
 * VS Code commands can be invoked with any argument shape: a malformed
 * payload is warned about and yields `null`, which sends the run to output
 * discovery instead.
 */
export function normalizeRunLatexdiffOutputsByRound(
  value: unknown,
): RoundIndexed<OutputFileInfo> | null {
  if (value == null) return null;
  const result = roundIndexedRecord(OutputFileInfoSchema).safeParse(value);
  if (!result.success) {
    console.warn(
      `[latexdiff] Ignoring malformed outputsByRound payload: ${result.error.message}`,
    );
    return null;
  }
  return Object.values(result.data).some((files) => files.length > 0)
    ? result.data
    : null;
}

/** How the round outputs fed to the diff engine were resolved. */
type LatexdiffOutputsSource = 'metadata' | 'run-dir-scan' | 'workspace-scan';

export interface RunLatexdiffForRunParams {
  readonly agent: string;
  readonly model: string;
  readonly inputFile: string;
  /** Agent-owned run listing injected by hosts (metadata auto-discovery). */
  readonly runDiscovery: LatexRunDiscoveryPort;
  readonly filesystem: RunOutputFilesystem;
  readonly outputFiles?: string[];
  /** Run to scope output discovery to (progress-toolbar invocations). */
  readonly runId?: string | null;
  /**
   * Pre-resolved round outputs (e.g. from a progress-toolbar payload). When
   * present, discovery is skipped and the metadata engine runs directly.
   */
  readonly outputsByRound?: ReadonlyRoundIndexed<OutputFileInfo> | null;
  readonly mathMarkup?: MathMarkupOption;
  readonly generateBetweenRoundDiffs: boolean;
  /** Host-supplied diff service + logger channel (see {@link LatexdiffRuntime}). */
  readonly latexdiff: LatexdiffRuntime;
  readonly progress: DiffProgressReporter;
}

interface LatexdiffExecutionResult {
  readonly outcome: DiffRunOutcome;
  /** Resolved run, when one was identified. */
  readonly runId?: RunId;
  readonly source: LatexdiffOutputsSource;
}

export const runLatexdiffForRun = Effect.fn('runLatexdiffForRun')(
  function* (
    params: RunLatexdiffForRunParams,
  ): Effect.fn.Return<LatexdiffExecutionResult, Error> {
    const {
      agent,
      model,
      inputFile,
      runDiscovery,
      outputFiles,
      mathMarkup,
      generateBetweenRoundDiffs,
      latexdiff,
      progress,
    } = params;
    const runId = params.runId ?? undefined;

    let outputsByRound = params.outputsByRound ?? null;
    let source: LatexdiffOutputsSource = outputsByRound
      ? 'metadata'
      : 'workspace-scan';
    let discoveredRunId: RunId | undefined;

    // When the caller pins a runId (progress-toolbar invocations do), scope
    // output discovery to that run first. Otherwise metadata
    // auto-discovery can return a different, newer run with the same
    // agent/model/inputFile: silently diffing against the wrong outputs.
    if (!outputsByRound && runId) {
      const parsedRunId = RunIdSchema.safeParse(runId);
      if (parsedRunId.success) {
        const scanned = yield* scanRunDirForOutputs(
          parsedRunId.data,
          inputFile,
          outputFiles,
          latexdiff.channel,
          params.filesystem,
        );
        if (scanned) {
          outputsByRound = scanned;
          source = 'run-dir-scan';
          discoveredRunId = parsedRunId.data;
          yield* Effect.logDebug(
            `Using run-dir scan outputs from run ${parsedRunId.data}`,
          );
        }
      }
    }

    // No runId given: fall back to searching executions by agent/model/inputFile
    // and pulling their persisted metadata. When the caller pinned a runId but
    // the run-dir scan turned up nothing, DO NOT drop to latest-matching
    // auto-discovery: that would silently diff against a different (usually
    // newer) run with the same agent/model/input.
    if (!outputsByRound && !runId) {
      const discovered = yield* discoverLatestRunOutputs(
        runDiscovery,
        {
          agent,
          model,
          inputFile,
        },
        latexdiff.channel,
        params.filesystem,
      );
      if (discovered) {
        outputsByRound = discovered.rounds;
        source = 'metadata';
        discoveredRunId = discovered.runId;
        yield* Effect.logDebug(
          `Using metadata outputs from run ${discovered.runId}`,
        );
      }
    }

    const rounds = outputsByRound;
    const outcome = yield* rounds
      ? runLatexdiffFromMetadata({
          rounds,
          mathMarkup,
          generateBetweenRoundDiffs,
          latexdiff,
          progress,
        })
      : runLatexdiffViaWorkspaceScan({
          agent,
          model,
          inputFile,
          outputFiles,
          mathMarkup,
          generateBetweenRoundDiffs,
          latexdiff,
          progress,
        });

    return { outcome, runId: discoveredRunId, source };
  },
  // One channel for the whole run, so the discovery steps and the diff engine
  // below both land on the caller's channel.
  (effect, params) => withLogChannel(params.latexdiff.channel)(effect),
);
