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
  fileInfos: OutputFileInfo[];
  filesToOpen: FileLocation[];
  stage?: StageHandle;
}

export async function summarizeRound(
  state: OutputState,
  deps: OutputDependencies,
  outputFile: FileLocation,
  currRound: number,
  options: {
    endTurn: boolean;
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
    undefined,
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

      return { fileInfos, filesToOpen, stage: scope };
    },
  );
}
