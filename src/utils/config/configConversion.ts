// Local imports - models
import { type AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';

// Type imports
import {
  type TaskState,
  type ToolUseTaskState,
  type WorkflowTaskState,
} from '@logger/TaskState';

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
 * Type predicates for AgentConfig category narrowing.
 * TypeScript's control flow analysis doesn't narrow nested properties,
 * so we use these predicates to enable proper type narrowing without casts.
 */
function isToolUseAgentConfig(
  config: AgentConfig,
): config is ToolUseTaskState['agentConfig'] {
  return config.session?.agentCategory === AgentCategory.ToolUse;
}

function isWorkflowAgentConfig(
  config: AgentConfig,
): config is WorkflowTaskState['agentConfig'] {
  return config.session?.agentCategory === AgentCategory.Workflow;
}

/**
 * Converts an AgentConfig object to a TaskState object.
 * Session metadata comes from config.session (single source of truth).
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  if (!config.session) {
    throw new Error('AgentConfig is missing canonical session metadata.');
  }

  if (isToolUseAgentConfig(config)) {
    return {
      agentConfig: config,
      toolSessionState: {},
    };
  }

  if (isWorkflowAgentConfig(config)) {
    return {
      agentConfig: config,
      activeFiles: createActiveFilesFromArrays(config),
    };
  }

  // Should be unreachable - all AgentCategory values are handled
  throw new Error(
    `Unknown agent category: ${(config.session as { agentCategory: string }).agentCategory}`,
  );
}
