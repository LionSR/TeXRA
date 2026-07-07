/**
 * Host-neutral orchestration for a full latexdiff run.
 *
 * Resolves which round outputs to diff — preferring caller-supplied metadata,
 * then a run-id-scoped run-dir scan, then agent/model/input auto-discovery —
 * and dispatches to the metadata-driven or workspace-scan diff engine. This is
 * the single source of truth shared by every host (VS Code command, CLI,
 * desktop); each host keeps only its own UX (progress chrome, prompts, result
 * rendering) and calls this with a {@link DiffProgressReporter}.
 */

import * as logger from '@logger/logUtils';
import { ExecutionIdSchema } from '@shared/schemas';
import type { ExecutionId, OutputFileInfo } from '@shared/schemas';

import {
  runLatexdiffFromMetadata,
  runLatexdiffViaWorkspaceScan,
} from './diffOperations';
import {
  discoverLatestExecutionOutputs,
  scanRunDirForOutputs,
} from './outputDiscovery';
import { CHANNEL } from './service';
import type { MathMarkupOption } from './mathMarkup';
import type { DiffProgressReporter, DiffRunOutcome } from './types';

/**
 * Normalize arbitrary command payload metadata into the internal round map.
 * VS Code commands can be invoked with any argument shape, so only the current
 * tuple-array form is trusted; malformed or legacy map-shaped values fall back
 * to discovery instead of crashing the command handler.
 */
export function normalizeRunLatexdiffOutputsByRound(
  value: unknown,
): Map<number, OutputFileInfo[]> | null {
  if (!Array.isArray(value)) return null;

  const validRounds = value
    .filter(
      (entry): entry is [number, OutputFileInfo[]] =>
        Array.isArray(entry) &&
        typeof entry[0] === 'number' &&
        Number.isInteger(entry[0]) &&
        Array.isArray(entry[1]) &&
        entry[1].length > 0,
    )
    .sort((a, b) => a[0] - b[0]);

  return validRounds.length > 0 ? new Map(validRounds) : null;
}

/** How the round outputs fed to the diff engine were resolved. */
export type LatexdiffOutputsSource =
  'metadata' | 'run-dir-scan' | 'workspace-scan';

export interface RunLatexdiffForExecutionParams {
  readonly agent: string;
  readonly model: string;
  readonly inputFile: string;
  readonly outputFiles?: string[];
  /** Execution to scope output discovery to (progress-toolbar invocations). */
  readonly runId?: string | null;
  /**
   * Pre-resolved round outputs (e.g. from a progress-toolbar payload). When
   * present, discovery is skipped and the metadata engine runs directly.
   */
  readonly outputsByRound?: Map<number, OutputFileInfo[]> | null;
  readonly mathMarkup?: MathMarkupOption;
  readonly generateBetweenRoundDiffs: boolean;
  readonly progress: DiffProgressReporter;
}

export interface LatexdiffExecutionResult {
  readonly outcome: DiffRunOutcome;
  /** Resolved execution, when one was identified. */
  readonly executionId?: ExecutionId;
  readonly source: LatexdiffOutputsSource;
}

export async function runLatexdiffForExecution(
  params: RunLatexdiffForExecutionParams,
): Promise<LatexdiffExecutionResult> {
  const {
    agent,
    model,
    inputFile,
    outputFiles,
    mathMarkup,
    generateBetweenRoundDiffs,
    progress,
  } = params;
  const runId = params.runId ?? undefined;

  let outputsByRound = params.outputsByRound ?? null;
  let source: LatexdiffOutputsSource = outputsByRound
    ? 'metadata'
    : 'workspace-scan';
  let discoveredExecutionId: ExecutionId | undefined;

  // When the caller pins a runId (progress-toolbar invocations do), scope
  // output discovery to that execution first. Otherwise metadata
  // auto-discovery can return a different, newer run with the same
  // agent/model/inputFile — silently diffing against the wrong outputs.
  if (!outputsByRound && runId) {
    const parsedRunId = ExecutionIdSchema.safeParse(runId);
    if (parsedRunId.success) {
      const scanned = await scanRunDirForOutputs(
        parsedRunId.data,
        inputFile,
        outputFiles,
      );
      if (scanned) {
        outputsByRound = scanned;
        source = 'run-dir-scan';
        discoveredExecutionId = parsedRunId.data;
        logger.debug(
          CHANNEL,
          `Using run-dir scan outputs from execution ${parsedRunId.data}`,
        );
      }
    }
  }

  // No runId given: fall back to searching executions by agent/model/inputFile
  // and pulling their persisted metadata. When the caller pinned a runId but
  // the run-dir scan turned up nothing, DO NOT drop to latest-matching
  // auto-discovery — that would silently diff against a different (usually
  // newer) execution with the same agent/model/input.
  if (!outputsByRound && !runId) {
    const discovered = await discoverLatestExecutionOutputs({
      agent,
      model,
      inputFile,
    });
    if (discovered) {
      outputsByRound = discovered.rounds;
      source = 'metadata';
      discoveredExecutionId = discovered.executionId;
      logger.debug(
        CHANNEL,
        `Using metadata outputs from execution ${discovered.executionId}`,
      );
    }
  }

  const outcome = outputsByRound
    ? await runLatexdiffFromMetadata({
        rounds: outputsByRound,
        mathMarkup,
        generateBetweenRoundDiffs,
        progress,
      })
    : await runLatexdiffViaWorkspaceScan({
        agent,
        model,
        inputFile,
        outputFiles,
        mathMarkup,
        generateBetweenRoundDiffs,
        progress,
      });

  return { outcome, executionId: discoveredExecutionId, source };
}
