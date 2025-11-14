// Standard library imports
// (none needed)

// Local imports - models
import { type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentCategory,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';

// Type imports
import { type TaskState } from '@logger/TaskState';

// Local file imports
import { FILE_TYPES, type FileType } from './constants';

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
