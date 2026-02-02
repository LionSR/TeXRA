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

/** Check if a file type is active based on the config fields. */
function isFileTypeActive(
  config: Record<string, unknown>,
  type: FileType,
  useMultipleOutputs: boolean,
): boolean {
  const filesField = `${type}Files`;
  const flagField = `${filesField}Active`;
  const files = config[filesField];

  if (Array.isArray(files) && files.length > 0) return true;
  if (config[flagField]) return true;
  if (type === 'output' && useMultipleOutputs) return true;
  return false;
}

/**
 * Converts an AgentConfig object to a TaskState object.
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  switch (config.agentCategory) {
    case AgentCategory.ToolUse:
      return {
        agentConfig: config as ToolUseTaskState['agentConfig'],
        toolSessionState: {},
      };
    case AgentCategory.Workflow: {
      const configRecord = config as Record<string, unknown>;
      const useMultipleOutputs = Boolean(configRecord.useMultipleOutputs);
      const activeFiles = {} as Record<FileType, boolean>;

      for (const type of FILE_TYPES) {
        activeFiles[type] = isFileTypeActive(
          configRecord,
          type,
          useMultipleOutputs,
        );
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
