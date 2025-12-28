/**
 * Shared helper functions for ReflectionFlow nodes.
 *
 * These helpers consolidate logic that would otherwise be duplicated
 * across multiple nodes, following DRY principles.
 */

import type { RoundOutput } from '@agent/output';

import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  WorkspaceFS,
  createWorkspaceLocation,
  type FileLocation,
  type TaskRunFileService,
  type WorkspaceFileLocation,
} from '@utils/files';

/**
 * Determine which files to process for a given round.
 *
 * Used by TeXCountNode and MediaPreparationNode to avoid duplicating
 * the file determination logic.
 *
 * @param currentRound - Current round index (0-based)
 * @param roundOutputs - Outputs from previous rounds
 * @param config - Agent configuration
 * @param fileService - File service for creating locations
 * @returns Array of file locations to process
 */
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
  if (prevOutput && prevOutput.outputs.length > 0) {
    return prevOutput.outputs.map((o) => o.location);
  }

  // Fallback to configured output files
  if (config.outputFiles.length > 0) {
    return config.outputFiles.map((f) => fileService.createLocation(f));
  }

  return [];
}

/**
 * Create base file locations for latexdiff and artifact tracking.
 *
 * Base files are ALWAYS workspace locations (inputs from workspace).
 * Even in run-storage mode, we snapshot FROM workspace TO run storage.
 * Latexdiff must reference the original workspace files, not their
 * run storage copies.
 *
 * @param config - Agent configuration with outputFiles and inputFile
 * @returns Array of workspace file locations for base files
 */
export function createBaseFileLocations(
  config: AgentConfig,
): WorkspaceFileLocation[] {
  return config.outputFiles.length > 0
    ? config.outputFiles.map((f) =>
        createWorkspaceLocation(WorkspaceFS.fullPath(f), f),
      )
    : [
        createWorkspaceLocation(
          WorkspaceFS.fullPath(config.inputFile),
          config.inputFile,
        ),
      ];
}
