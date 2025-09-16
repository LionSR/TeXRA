// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { TaskState } from '@logger/TaskState';
import type { AgentType } from '@agent/core/AgentDataclass';

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
export function agentConfigToTaskState(
  config: AgentConfig,
  agentType?: AgentType,
): TaskState {
  return {
    agentConfig: config,
    activeFiles: createActiveFilesFromArrays(config),
    ...(agentType ? { agentType } : {}),
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
  // Check if this is already in the new format with nested agentConfig
  if (obj.agentConfig && typeof obj.agentConfig === 'object') {
    // Already in new format, just ensure it's valid
    return {
      agentConfig: AgentConfigSchema.parse(obj.agentConfig),
      activeFiles:
        obj.activeFiles || createActiveFilesFromArrays(obj.agentConfig),
      agentType: obj.agentType,
    };
  }

  // Old format: extract UI-specific and tool config fields for backward compatibility
  const {
    activeFiles,
    // Extract tool config fields that might be at top level in old format
    autoExtractFigure,
    autoExtractTikzFigure,
    autoCompileInputPdf,
    attachTeXCount,
    printInputPrompt,
    reflect,
    ...agentConfigData
  } = obj;

  // Build toolConfig from extracted fields (backward compatibility)
  // Ensure toolConfig is an object, handling cases where it might be malformed
  if (
    !agentConfigData.toolConfig ||
    typeof agentConfigData.toolConfig !== 'object'
  ) {
    agentConfigData.toolConfig = {};
  }

  // Merge top-level tool config fields into toolConfig
  // Top-level fields take precedence for backward compatibility
  agentConfigData.toolConfig = {
    ...agentConfigData.toolConfig,
    ...(autoExtractFigure !== undefined && { autoExtractFigure }),
    ...(autoExtractTikzFigure !== undefined && { autoExtractTikzFigure }),
    ...(autoCompileInputPdf !== undefined && { autoCompileInputPdf }),
    ...(attachTeXCount !== undefined && { attachTeXCount }),
    ...(printInputPrompt !== undefined && { printInputPrompt }),
    ...(reflect !== undefined && { reflect }),
  };

  // Parse only AgentConfig-compatible fields
  try {
    const normalized = AgentConfigSchema.parse(agentConfigData);
    const taskState = agentConfigToTaskState(normalized, obj.agentType);

    // Add back TaskState-specific fields
    if (activeFiles) {
      taskState.activeFiles = activeFiles;
    }

    return taskState;
  } catch (error) {
    // If parsing fails, create a minimal valid state
    console.error('Failed to parse task state, using defaults:', error);
    const defaultConfig = AgentConfigSchema.parse({});
    const taskState = agentConfigToTaskState(defaultConfig, obj.agentType);

    // Preserve activeFiles if available
    if (activeFiles) {
      taskState.activeFiles = activeFiles;
    }

    return taskState;
  }
}
