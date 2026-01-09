/**
 * Shared helper functions for ReflectionFlow nodes.
 *
 * These helpers consolidate logic that would otherwise be duplicated
 * across multiple nodes, following DRY principles.
 */

import * as path from 'path';

import type { RoundOutput } from '@agent/output';

import type { AgentConfig } from '@agent/core/AgentConfig';
import type {
  AgentWorkflowSetting,
  AgentPrompt,
} from '@agent/core/AgentDataclass';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import {
  WorkspaceFS,
  createWorkspaceLocation,
  type AgentFileLocation,
  type FileLocation,
  type TaskRunFileService,
  type WorkspaceFileLocation,
} from '@utils/files';

/**
 * Determine which files to process for a given round.
 *
 * Used by TeXCountNode and MediaExtractionNode to avoid duplicating
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
  if (prevOutput?.outputs.length) {
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
  const files =
    config.outputFiles.length > 0 ? config.outputFiles : [config.inputFile];
  return files.map((f) => {
    // Handle absolute paths correctly: path.join() incorrectly concatenates
    // when the second arg is absolute, so we must check first.
    // See resolveFilePath in pathUtils.ts for the canonical pattern.
    const absolutePath = path.isAbsolute(f) ? f : WorkspaceFS.fullPath(f);
    const relativePath = path.isAbsolute(f) ? WorkspaceFS.relativePath(f) : f;
    return createWorkspaceLocation(absolutePath, relativePath);
  });
}

/**
 * Compute whether to enforce XML structure in responses.
 *
 * Extracted from runReflectionFlow for clarity and testability.
 * Logic priority:
 * 1. Explicit xmlStructureMode setting takes precedence
 * 2. CoT agents always use XML structure
 * 3. Direct agents only use XML structure with scratchpad
 *
 * @param setting - Agent workflow settings
 * @param useScratchpad - Whether scratchpad prefill is enabled
 * @returns Whether to enforce XML structure
 */
export function computeShouldEnsureXmlStructure(
  setting: AgentWorkflowSetting,
  useScratchpad: boolean,
): boolean {
  if (setting.xmlStructureMode !== undefined) {
    return (
      setting.xmlStructureMode === 'always' ||
      (setting.xmlStructureMode === 'scratchpadOnly' && useScratchpad)
    );
  }
  if (setting.agentType === 'CoT') {
    return true;
  }
  if (setting.agentType === 'direct') {
    return useScratchpad;
  }
  return false;
}

/**
 * Compute total rounds for workflow execution.
 *
 * Extracted from runReflectionFlow for clarity and testability.
 * Logic priority:
 * 1. Explicit maxRounds setting takes precedence
 * 2. Direct agents always run 1 round
 * 3. Otherwise use max of configured rounds or request count
 *
 * @param setting - Agent workflow settings
 * @param prompt - Agent prompt with user requests
 * @returns Number of rounds to execute
 */
export function computeTotalRounds(
  setting: AgentWorkflowSetting,
  prompt: AgentPrompt,
): number {
  if (setting.maxRounds !== undefined) {
    return setting.maxRounds;
  }
  if (setting.agentType === 'direct') {
    return 1;
  }
  const requests = Array.isArray(prompt.userRequest)
    ? prompt.userRequest
    : prompt.userRequest
      ? [prompt.userRequest]
      : [];
  return Math.max(setting.rounds ?? 2, requests.length);
}

/**
 * Parameters for creating an output file location getter.
 */
interface OutputFileLocationParams {
  fileService: TaskRunFileService;
  config: AgentConfig;
  modelName: string;
  setting: AgentWorkflowSetting;
  useScratchpad: boolean;
}

/**
 * Create a function that generates output file locations for each round.
 *
 * Extracted from runReflectionFlow for clarity and reuse.
 *
 * @param params - Configuration for output file generation
 * @returns Function that maps round number to output file location
 */
export function createOutputFileLocationGetter(
  params: OutputFileLocationParams,
): (round: number) => AgentFileLocation {
  const { fileService, config, modelName, setting, useScratchpad } = params;
  const fileExtension = useScratchpad ? 'xml' : setting.outputExt;

  return (currRound: number): AgentFileLocation => {
    const fileName = getOutputFileName(
      config.inputFile,
      config.agent,
      modelName,
      fileExtension,
      currRound,
      config.editedFile || undefined,
    );
    return (
      useScratchpad
        ? fileService.createRawOutputLocation(fileName)
        : fileService.createLocation(fileName)
    ) as AgentFileLocation;
  };
}
