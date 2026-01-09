/** Shared helper functions for ReflectionFlow nodes. */

import * as path from 'path';

import type { RoundOutput } from '@agent/output';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentWorkflowSetting, AgentPrompt } from '@agent/core/AgentDataclass';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import {
  WorkspaceFS,
  createWorkspaceLocation,
  type AgentFileLocation,
  type FileLocation,
  type TaskRunFileService,
  type WorkspaceFileLocation,
} from '@utils/files';

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

/** Create workspace file locations for latexdiff base files. */
export function createBaseFileLocations(config: AgentConfig): WorkspaceFileLocation[] {
  const files = config.outputFiles.length > 0 ? config.outputFiles : [config.inputFile];
  return files.map((f) => {
    const absolutePath = path.isAbsolute(f) ? f : WorkspaceFS.fullPath(f);
    const relativePath = path.isAbsolute(f) ? WorkspaceFS.relativePath(f) : f;
    return createWorkspaceLocation(absolutePath, relativePath);
  });
}

/** Determine if XML structure should be enforced based on setting and agent type. */
export function computeShouldEnsureXmlStructure(
  setting: AgentWorkflowSetting,
  useScratchpad: boolean,
): boolean {
  if (setting.xmlStructureMode !== undefined) {
    return setting.xmlStructureMode === 'always' ||
      (setting.xmlStructureMode === 'scratchpadOnly' && useScratchpad);
  }
  if (setting.agentType === 'CoT') return true;
  if (setting.agentType === 'direct') return useScratchpad;
  return false;
}

/** Compute total rounds: explicit maxRounds, or 1 for direct, or max(rounds, requests). */
export function computeTotalRounds(setting: AgentWorkflowSetting, prompt: AgentPrompt): number {
  if (setting.maxRounds !== undefined) return setting.maxRounds;
  if (setting.agentType === 'direct') return 1;
  const requests = Array.isArray(prompt.userRequest)
    ? prompt.userRequest
    : prompt.userRequest ? [prompt.userRequest] : [];
  return Math.max(setting.rounds ?? 2, requests.length);
}

/** Create a getter for output file locations per round. */
export function createOutputFileLocationGetter(params: {
  fileService: TaskRunFileService;
  config: AgentConfig;
  modelName: string;
  setting: AgentWorkflowSetting;
  useScratchpad: boolean;
}): (round: number) => AgentFileLocation {
  const { fileService, config, modelName, setting, useScratchpad } = params;
  const ext = useScratchpad ? 'xml' : setting.outputExt;

  return (round: number): AgentFileLocation => {
    const fileName = getOutputFileName(config.inputFile, config.agent, modelName, ext, round, config.editedFile || undefined);
    return (useScratchpad ? fileService.createRawOutputLocation(fileName) : fileService.createLocation(fileName)) as AgentFileLocation;
  };
}
