// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { TaskState, isWorkflowTaskState } from '@logger/TaskState';
import {
  AgentSessionKind,
  type AgentType,
  type AgentSessionMetadata,
  resolveAgentSessionMetadata,
} from '@agent/core/AgentDataclass';

import { FILE_TYPES, type FileType } from './constants';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createActiveFilesFromArrays(
  src: Record<string, any>,
): Record<FileType, boolean> {
  const active: Record<FileType, boolean> = {} as Record<FileType, boolean>;
  FILE_TYPES.forEach((type) => {
    const filesField = `${type}Files`;
    const flagField = `${filesField}Active`;
    const useMultipleOutputs = Boolean(
      (src as { useMultipleOutputs?: boolean }).useMultipleOutputs,
    );
    const multipleFlag = type === 'output' && useMultipleOutputs;
    active[type] =
      (Array.isArray(src[filesField]) && src[filesField].length > 0) ||
      !!src[flagField] ||
      multipleFlag;
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
  metadata?: AgentSessionMetadata | AgentType,
): TaskState {
  const resolvedMetadata =
    typeof metadata === 'object' && metadata !== null
      ? resolveAgentSessionMetadata(
          metadata.agentType,
          metadata.agentSessionKind,
        )
      : resolveAgentSessionMetadata(metadata);

  if (resolvedMetadata.agentSessionKind === AgentSessionKind.ToolUse) {
    return {
      agentConfig: config,
      agentType: resolvedMetadata.agentType,
      agentSessionKind: AgentSessionKind.ToolUse,
      toolSessionState: {},
    };
  }

  return {
    agentConfig: config,
    agentType: resolvedMetadata.agentType,
    agentSessionKind: AgentSessionKind.Workflow,
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
  // Check if this is already in the new format with nested agentConfig
  if (obj.agentConfig && typeof obj.agentConfig === 'object') {
    const agentType = obj.agentType as AgentType | undefined;
    const sessionKind = normalizeSessionKind(obj.agentSessionKind);
    const metadata = resolveAgentSessionMetadata(agentType, sessionKind);
    const state = agentConfigToTaskState(
      AgentConfigSchema.parse(obj.agentConfig),
      metadata,
    );

    if (isWorkflowTaskState(state)) {
      state.activeFiles =
        obj.activeFiles || createActiveFilesFromArrays(obj.agentConfig);
    } else if (isObjectRecord(obj.toolSessionState)) {
      state.toolSessionState = { ...obj.toolSessionState };
    }

    return state;
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
    const agentType = obj.agentType as AgentType | undefined;
    const sessionKind = normalizeSessionKind(obj.agentSessionKind);
    const metadata = resolveAgentSessionMetadata(agentType, sessionKind);
    const taskState = agentConfigToTaskState(normalized, metadata);

    if (isWorkflowTaskState(taskState)) {
      if (activeFiles) {
        taskState.activeFiles = activeFiles;
      }
    } else if (isObjectRecord(obj.toolSessionState)) {
      taskState.toolSessionState = { ...obj.toolSessionState };
    }

    return taskState;
  } catch (error) {
    // If parsing fails, create a minimal valid state
    console.error('Failed to parse task state, using defaults:', error);
    const defaultConfig = AgentConfigSchema.parse({});
    const agentType = obj.agentType as AgentType | undefined;
    const metadata = resolveAgentSessionMetadata(agentType);
    const taskState = agentConfigToTaskState(defaultConfig, metadata);

    if (isWorkflowTaskState(taskState) && activeFiles) {
      taskState.activeFiles = activeFiles;
    }

    if (!isWorkflowTaskState(taskState) && isObjectRecord(obj.toolSessionState)) {
      taskState.toolSessionState = { ...obj.toolSessionState };
    }

    return taskState;
  }
}

function normalizeSessionKind(value: unknown): AgentSessionKind | undefined {
  if (
    value === AgentSessionKind.Workflow ||
    value === AgentSessionKind.ToolUse
  ) {
    return value;
  }
  return undefined;
}
