// Standard library imports
// (none needed)

// Local imports - models
import { type AgentConfig, parseAgentConfig } from '@agent/core/AgentConfig';
import {
  type TaskState,
  isWorkflowTaskState,
  isToolUseTaskState,
} from '@logger/TaskState';
import {
  AgentCategory,
  type AgentSessionDescriptor,
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
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  const session = config.session;
  if (!session) {
    throw new Error('AgentConfig is missing canonical session metadata.');
  }

  const sanitizedConfig: AgentConfig = { ...config };

  if (session.agentCategory === AgentCategory.ToolUse) {
    const toolUseSession: AgentSessionDescriptor & {
      agentCategory: AgentCategory.ToolUse;
    } = {
      ...session,
      agentCategory: AgentCategory.ToolUse,
    };
    return {
      agentConfig: sanitizedConfig,
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
    agentConfig: sanitizedConfig,
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
  const nestedConfig = isObjectRecord(obj.agentConfig)
    ? (obj.agentConfig as Record<string, unknown>)
    : null;

  if (!nestedConfig || !isObjectRecord(nestedConfig.session)) {
    throw new Error('Serialized task state is missing canonical session data.');
  }

  const normalizedConfig = parseAgentConfig(nestedConfig);
  const taskState = agentConfigToTaskState(normalizedConfig);

  if (isWorkflowTaskState(taskState)) {
    if (isObjectRecord(obj.activeFiles)) {
      taskState.activeFiles = obj.activeFiles as Record<FileType, boolean>;
    }
  } else if (
    isToolUseTaskState(taskState) &&
    isObjectRecord(obj.toolSessionState)
  ) {
    taskState.toolSessionState = { ...obj.toolSessionState };
  }

  return taskState;
}

// normalizeSessionKind removed – canonical descriptor is now provided directly.
