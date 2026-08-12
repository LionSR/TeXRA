/**
 * Round summary and finalization for output processing.
 *
 * Finalizes round data after processing, collecting file info with
 * diff stats and preparing data for event emission and file opening.
 */

import type { StageHandle } from '@agent/trace';
import {
  MESSAGE_TYPES,
  type FileLocation,
  type OutputFileInfo,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';

import { computeOutputDiffStats } from './diffComputation';
import {
  ensureRoundData,
  getStorageKey,
  withOutputStage,
  type OutputState,
  type OutputDependencies,
} from './outputState';
import type { RoundFileMapping } from './types';

export interface RoundSummary {
  storageKey: StorageKey;
  currRound: number;
  fileInfos: OutputFileInfo[];
  filesToOpen: FileLocation[];
  outputFile: FileLocation;
  endTurn: boolean;
  stage?: StageHandle;
}

/**
 * Constructs a round summary with no file info — the double-fault fallback
 * used when summarizing has itself thrown. Built here rather than as a bare
 * literal at the call site so a new {@link RoundSummary} field is surfaced
 * by the factory instead of silently omitted.
 */
export function blankRoundSummary(options: {
  storageKey: StorageKey;
  currRound: number;
  outputFile: FileLocation;
  endTurn: boolean;
}): RoundSummary {
  return {
    storageKey: options.storageKey,
    currRound: options.currRound,
    fileInfos: [],
    filesToOpen: [],
    outputFile: options.outputFile,
    endTurn: options.endTurn,
  };
}

export async function summarizeRound(
  state: OutputState,
  deps: OutputDependencies,
  outputFile: FileLocation,
  currRound: number,
  options: {
    endTurn: boolean;
    stage?: StageHandle;
    mapping?: RoundFileMapping;
    isRewrite?: boolean;
    /** Snapshot-resolved base files. Required for in-place workflows so
     *  diff stats are computed against the pre-run snapshot rather than
     *  the overwritten workspace file. When omitted, falls back to
     *  deps.baseFiles (live workspace paths). */
    baseFiles?: FileLocation[];
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
        options.baseFiles ?? deps.baseFiles,
        currRound,
        options.mapping,
        { isRewrite: options.isRewrite },
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

      deps.logger.debug('Finalized round', {
        data: { round: currRound, storageKey, files: fileInfos.length },
        messageType: MESSAGE_TYPES.INTERNAL,
      });

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

export async function getRoundOutput(
  state: OutputState,
  baseFiles: FileLocation[],
  round: number,
  options?: { isRewrite?: boolean },
): Promise<RoundOutput> {
  const data = ensureRoundData(state, round);

  if (data.outputs.length === 0) {
    data.outputs = await computeOutputDiffStats(
      state,
      baseFiles,
      round,
      undefined,
      options,
    );
  }

  return data;
}
