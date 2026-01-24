/** Shared helper functions for ReflectionFlow nodes. */

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { RoundOutput } from '@agent/output';

// Local imports - shared schemas
import type { FileLocation } from '@shared/schemas';

// Local imports - utilities
import type { TaskRunFileService } from '@utils/files';

/** Get files to process for a round (input files for round 0, previous outputs otherwise). */
export function getFilesForRound(
  currentRound: number,
  roundOutputs: RoundOutput[],
  config: AgentConfig,
  fileService: TaskRunFileService,
): FileLocation[] {
  if (currentRound === 0) {
    // First round: process input files
    return [
      fileService.createLocation(config.inputFile),
      ...config.inputFiles.map((f) => fileService.createLocation(f)),
    ];
  }

  // Subsequent rounds: process previous round's output files
  const prevOutput = roundOutputs[currentRound - 1];
  if (prevOutput?.outputs.length) {
    return prevOutput.outputs.map((o) => o.location);
  }

  // Fallback to configured output files
  if (config.outputFiles.length > 0) {
    return config.outputFiles.map((f) => fileService.createLocation(f));
  }

  return [];
}
