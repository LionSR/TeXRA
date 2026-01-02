// Local imports - models
import { type AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentCategory } from '@agent/core/AgentDataclass';

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
 * Converts an AgentConfig object to a TaskState object.
 * Session metadata comes from config.session (single source of truth).
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
    return {
      agentConfig: config as TaskState['agentConfig'],
      toolSessionState: {},
    };
  }

  return {
    agentConfig: config as TaskState['agentConfig'],
    activeFiles: createActiveFilesFromArrays(config),
  };
}
