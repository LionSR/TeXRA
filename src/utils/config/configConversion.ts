// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import { AgentConfig, AgentConfigSchema } from '@agent/core/AgentConfig';
import { TaskState } from '@logger/TaskState';

import { FILE_TYPES, type FileType } from './constants';

function createActiveFilesFromArrays(
  src: Record<string, any>,
): Record<FileType, boolean> {
  const active: Record<FileType, boolean> = {} as Record<FileType, boolean>;
  FILE_TYPES.forEach((type) => {
    const filesField = `${type}Files`;
    const flagField = `${filesField}Active`;
    active[type] =
      (Array.isArray(src[filesField]) && src[filesField].length > 0) ||
      !!src[flagField];
  });
  return active;
}

/**
 * Converts an AgentConfig object to a TaskState object
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  return {
    agentConfig: config,
    activeFiles: createActiveFilesFromArrays(config),
  };
}

/**
 * Converts a generic object to a TaskState object
 * This is useful when receiving serialized data from the UI
 *
 * @param obj The object to convert
 * @returns A TaskState representing the same configuration
 */
export function objectToTaskState(obj: Record<string, any>): TaskState {
  // Extract UI-specific and tool config fields for backward compatibility
  const {
    activeFiles,
    // Extract tool config fields that might be at top level in old format
    autoExtractFigure,
    autoExtractTikzFigure,
    autoCompileInputPdf,
    attachTeXCount,
    usePrefillFromInput,
    printInputPrompt,
    reflect,
    ...agentConfigData
  } = obj;

  // Build toolConfig if it doesn't exist (backward compatibility)
  if (!agentConfigData.toolConfig) {
    agentConfigData.toolConfig = {
      autoExtractFigure,
      autoExtractTikzFigure,
      autoCompileInputPdf,
      attachTeXCount,
      usePrefillFromInput,
      printInputPrompt,
      reflect,
    };
  }

  // Parse only AgentConfig-compatible fields
  const normalized = AgentConfigSchema.parse(agentConfigData);
  const taskState = agentConfigToTaskState(normalized);

  // Add back TaskState-specific fields
  if (activeFiles) {
    taskState.activeFiles = activeFiles;
  }

  return taskState;
}
