/**
 * Round summary and finalization for output processing.
 *
 * Finalizes round data after processing, collecting file info with
 * diff stats and preparing data for event emission and file opening.
 */

import { Effect } from 'effect';

import {
  MESSAGE_TYPES,
  type FileLocation,
  type OutputFileInfo,
} from '@shared/schemas';

import { computeOutputDiffStats } from './diffComputation';
import {
  ensureRoundData,
  type OutputState,
  type OutputDependencies,
} from './outputState';
import type { RoundFileMapping } from './types';

export interface RoundSummary {
  fileInfos: OutputFileInfo[];
  filesToOpen: FileLocation[];
}

export const summarizeRound = Effect.fn('reflection.summarizeRound')(function* (
  state: OutputState,
  deps: OutputDependencies,
  outputFile: FileLocation,
  currRound: number,
  options: {
    mapping?: RoundFileMapping;
    isRewrite?: boolean;
    /** Snapshot-resolved base files. Required for in-place workflows so
     *  diff stats are computed against the pre-run snapshot rather than
     *  the overwritten workspace file. When omitted, falls back to
     *  deps.baseFiles (live workspace paths). */
    baseFiles?: FileLocation[];
  },
) {
  const data = ensureRoundData(state, currRound);
  data.rawOutput ??= outputFile;

  const fileInfos = yield* computeOutputDiffStats(
    state,
    deps.roots.workspace,
    options.baseFiles ?? deps.baseFiles,
    currRound,
    options.mapping,
    { isRewrite: options.isRewrite },
  );
  data.outputs = fileInfos;

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
    data: {
      round: currRound,
      files: fileInfos.length,
    },
    messageType: MESSAGE_TYPES.INTERNAL,
  });

  return { fileInfos, filesToOpen } satisfies RoundSummary;
});
