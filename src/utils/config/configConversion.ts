// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - models
import { type AgentConfig, parseAgentConfig } from '@agent/core/AgentConfig';
import { type TaskState, isWorkflowTaskState } from '@logger/TaskState';
import {
  AgentCategory,
  AgentType,
  type AgentSessionDescriptor,
  resolveAgentSessionDescriptor,
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

function coerceAgentType(value: unknown): AgentType | undefined {
  if (
    value === AgentType.CoT ||
    value === AgentType.Direct ||
    value === AgentType.ToolUse
  ) {
    return value;
  }
  return undefined;
}

function coerceAgentCategory(value: unknown): AgentCategory | undefined {
  if (value === AgentCategory.Workflow || value === AgentCategory.ToolUse) {
    return value;
  }
  return undefined;
}

function resolveSessionDescriptor(
  ...sources: Array<Record<string, any>>
): AgentSessionDescriptor | undefined {
  for (const source of sources) {
    const rawSession = source.session;
    if (isObjectRecord(rawSession)) {
      const descriptor = rawSession as Partial<AgentSessionDescriptor> & {
        agentCategory?: unknown;
        agentType?: unknown;
      };
      const agentCategory = coerceAgentCategory(descriptor.agentCategory);
      if (agentCategory) {
        return {
          agentCategory,
          agentType: coerceAgentType(descriptor.agentType),
        };
      }
    }
  }

  let agentType: AgentType | undefined;
  let agentCategory: AgentCategory | undefined;

  for (const source of sources) {
    if (!agentType) {
      agentType = coerceAgentType(source.agentType);
    }
    if (!agentCategory) {
      agentCategory = coerceAgentCategory(source.agentSessionKind);
    }
  }

  if (agentType || agentCategory) {
    return resolveAgentSessionDescriptor(agentType, agentCategory);
  }

  return undefined;
}

/**
 * Converts an AgentConfig object to a TaskState object
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  const session = config.session;
  if (!session) {
    throw new Error('AgentConfig is missing canonical session metadata.');
  }

  if (session.agentCategory === AgentCategory.ToolUse) {
    const toolUseSession: AgentSessionDescriptor & {
      agentCategory: AgentCategory.ToolUse;
    } = {
      ...session,
      agentCategory: AgentCategory.ToolUse,
    };
    return {
      agentConfig: config,
      session: toolUseSession,
      toolSessionState: {},
    };
  }

  const workflowSession: AgentSessionDescriptor & {
    agentCategory: AgentCategory.Workflow;
  } = {
    ...session,
    agentCategory: AgentCategory.Workflow,
  };

  return {
    agentConfig: config,
    session: workflowSession,
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
    const configSource = obj.agentConfig as Record<string, any>;
    const sessionDescriptor = resolveSessionDescriptor(configSource, obj);
    const configInput = {
      ...configSource,
      ...(sessionDescriptor ? { session: sessionDescriptor } : {}),
    };
    const state = agentConfigToTaskState(parseAgentConfig(configInput));

    if (isWorkflowTaskState(state)) {
      state.activeFiles =
        obj.activeFiles || createActiveFilesFromArrays(configSource);
    } else if (isObjectRecord(obj.toolSessionState)) {
      state.toolSessionState = { ...obj.toolSessionState };
    }

    return state;
  }

  // Old format: extract UI-specific and tool config fields for backward compatibility
  const {
    activeFiles,
    agentSessionKind: _agentSessionKind,
    // Extract tool config fields that might be at top level in old format
    autoExtractFigure,
    autoExtractTikzFigure,
    autoCompileInputPdf,
    attachTeXCount,
    toolSessionState,
    toolConfig: legacyToolConfig,
    ...agentConfigData
  } = obj;

  void _agentSessionKind;

  const baseToolConfig = isObjectRecord(legacyToolConfig)
    ? (legacyToolConfig as Record<string, unknown>)
    : {};

  const mergedToolConfig: Record<string, unknown> = {
    ...baseToolConfig,
    ...(autoExtractFigure !== undefined && { autoExtractFigure }),
    ...(autoExtractTikzFigure !== undefined && { autoExtractTikzFigure }),
    ...(autoCompileInputPdf !== undefined && { autoCompileInputPdf }),
    ...(attachTeXCount !== undefined && { attachTeXCount }),
  };

  const configInput: Record<string, unknown> = {
    ...agentConfigData,
    toolConfig: mergedToolConfig,
  };

  const sessionDescriptor = resolveSessionDescriptor(obj, configInput);
  if (sessionDescriptor) {
    configInput.session = sessionDescriptor;
  }

  const normalized = parseAgentConfig(configInput);
  const taskState = agentConfigToTaskState(normalized);

  if (isWorkflowTaskState(taskState)) {
    if (activeFiles) {
      taskState.activeFiles = activeFiles;
    }
  } else if (isObjectRecord(toolSessionState)) {
    taskState.toolSessionState = { ...toolSessionState };
  }

  return taskState;
}

// normalizeSessionKind removed – canonical descriptor is now provided directly.
