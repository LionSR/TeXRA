/** Shared helper functions for ReflectionFlow nodes. */

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { FileLocation, RoundOutput } from '@shared/schemas';
import type { TaskRunFileService } from '@utils/files/taskRunStorage';

/** Get files to process for a round (input files for round 0, previous outputs otherwise). */
export function getFilesForRound(
  currentRound: number,
  roundOutputs: RoundOutput[],
  config: AgentConfig,
  fileService: TaskRunFileService,
): FileLocation[] {
  if (currentRound === 0) {
    // First round: process input files
    return config.inputFiles.map((f) => fileService.createLocation(f));
  }

  // Subsequent rounds: process previous round's output files
  const prevOutput = roundOutputs[currentRound - 1];
  if (prevOutput?.outputs.length) {
    return prevOutput.outputs.map((o) => o.location);
  }

  // Fallback to configured output files
  if (config.outputFiles.length) {
    return config.outputFiles.map((f) => fileService.createLocation(f));
  }

  return [];
}
