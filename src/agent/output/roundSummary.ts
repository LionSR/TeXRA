/**
 * Round summary and finalization for output processing.
 *
 * Finalizes round data after processing, collecting file info with
 * diff stats and preparing data for event emission and file opening.
 */

import {
  MESSAGE_TYPES,
  type FileLocation,
  type OutputFileInfo,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import type { AgentLogStage } from '@logger/AgentLogger';

import { computeOutputDiffStats } from './diffComputation';
import {
  ensureRoundData,
  getStorageKey,
  type OutputState,
  type OutputDependencies,
} from './outputState';
import type { RoundFileMapping } from './types';

// ============================================================================
// Types
// ============================================================================

/** Result of summarizing a round. */
export interface RoundSummary {
  storageKey: StorageKey;
  currRound: number;
  fileInfos: OutputFileInfo[];
  filesToOpen: FileLocation[];
  outputFile: FileLocation;
  endTurn: boolean;
  stage?: AgentLogStage;
}

// ============================================================================
// Helpers
// ============================================================================

async function withOutputStage<T>(
  deps: OutputDependencies,
  label: string,
  parentStage: AgentLogStage | undefined,
  fn: (stage: AgentLogStage) => Promise<T>,
): Promise<T> {
  const stage = await deps.logger.stage(`Output: ${label}`, {
    parent: parentStage,
    skip: true,
  });
  return stage.run(() => fn(stage));
}

// ============================================================================
// Public API
// ============================================================================

/** Summarizes a round after processing, computing diff stats and collecting artifacts. */
export async function summarizeRound(
  state: OutputState,
  deps: OutputDependencies,
  outputFile: FileLocation,
  currRound: number,
  options: {
    endTurn: boolean;
    stage?: AgentLogStage;
    mapping?: RoundFileMapping;
  },
): Promise<RoundSummary> {
  return withOutputStage(
    deps,
    `Finalize r${currRound}`,
    options.stage,
    async (scope): Promise<RoundSummary> => {
      const data = ensureRoundData(state, currRound);
      data.rawOutput ??= outputFile;

      const fileInfos = await computeOutputDiffStats(
        state,
        deps.baseFiles,
        currRound,
        options.mapping,
      );
      data.outputs = fileInfos;
      const storageKey = getStorageKey(state);

      // Collect file paths that haven't been opened yet
      const filesToOpen: FileLocation[] = [];
      for (const info of fileInfos) {
        const filePath = info.location.absolutePath;
        if (!state.openedOutputs.has(filePath)) {
          filesToOpen.push(info.location);
          state.openedOutputs.add(filePath);
        }
      }

      deps.logger.debug(
        `Finalized round ${currRound} storageKey=${storageKey} files=${fileInfos.length}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );

      return {
        storageKey,
        currRound,
        fileInfos,
        filesToOpen,
        outputFile,
        endTurn: options.endTurn,
        stage: scope,
      };
    },
  );
}

/** Gets round output artifacts. */
export async function getRoundOutput(
  state: OutputState,
  baseFiles: FileLocation[],
  round: number,
): Promise<RoundOutput> {
  const data = ensureRoundData(state, round);

  if (data.outputs.length === 0) {
    data.outputs = await computeOutputDiffStats(state, baseFiles, round);
  }

  return {
    round,
    rawOutput: data.rawOutput,
    outputs: data.outputs,
    xmlSummary: data.xmlSummary,
  };
}
