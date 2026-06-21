import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  type TaskState,
  type ToolUseTaskState,
  type WorkflowTaskState,
} from '@agent/core/execution/TaskState';

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
    case AgentCategory.Workflow:
      return {
        agentConfig: config as WorkflowTaskState['agentConfig'],
        activeFiles: {
          input: (config.inputFiles?.length ?? 0) > 0,
          context: (config.contextFiles?.length ?? 0) > 0,
          media: (config.mediaFiles?.length ?? 0) > 0,
          output: (config.outputFiles?.length ?? 0) > 0,
        },
      };
    default: {
      const _exhaustive: never = config.agentCategory;
      throw new Error(`Unknown agent category: ${_exhaustive}`);
    }
  }
}
