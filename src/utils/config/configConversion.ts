// Local imports - models
import { type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Type imports
import {
  type TaskState,
  type ToolUseTaskState,
  type WorkflowTaskState,
} from '@logger/TaskState';

// Local file imports
import { FILE_TYPES, type FileType } from './constants';

/**
 * Converts an AgentConfig object to a TaskState object.
 *
 * @param config The AgentConfig to convert
 * @returns A TaskState representing the same configuration
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  switch (config.agentCategory) {
    case AgentCategory.ToolUse:
      return {
        agentConfig: config as ToolUseTaskState['agentConfig'],
        toolSessionState: {},
      };
    case AgentCategory.Workflow: {
      // Build activeFiles inline - determines which file types are active
      const activeFiles = {} as Record<FileType, boolean>;
      const useMultipleOutputs = Boolean(
        (config as { useMultipleOutputs?: boolean }).useMultipleOutputs,
      );
      for (const type of FILE_TYPES) {
        const filesField = `${type}Files`;
        const flagField = `${filesField}Active`;
        const multipleFlag = type === 'output' && useMultipleOutputs;
        activeFiles[type] =
          (Array.isArray((config as Record<string, unknown>)[filesField]) &&
            ((config as Record<string, unknown>)[filesField] as unknown[])
              .length > 0) ||
          !!(config as Record<string, unknown>)[flagField] ||
          multipleFlag;
      }
      return {
        agentConfig: config as WorkflowTaskState['agentConfig'],
        activeFiles,
      };
    }
    default: {
      const _exhaustive: never = config.agentCategory;
      throw new Error(`Unknown agent category: ${_exhaustive}`);
    }
  }
}
