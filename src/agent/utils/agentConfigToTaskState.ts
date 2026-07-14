import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { type TaskState } from '@agent/core/state/TaskState';

/**
 * Converts an AgentConfig object to a TaskState object.
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  const { agentCategory } = config;
  switch (agentCategory) {
    case AgentCategory.ToolUse:
      return {
        agentConfig: config,
      };
    case AgentCategory.Workflow:
      return {
        agentConfig: config,
        activeFiles: {
          input: config.inputFiles.length > 0,
          context: config.contextFiles.length > 0,
          media: config.mediaFiles.length > 0,
          output: config.outputFiles.length > 0,
        },
      };
    default: {
      const _exhaustive: never = agentCategory;
      throw new Error(`Unknown agent category: ${String(_exhaustive)}`);
    }
  }
}
