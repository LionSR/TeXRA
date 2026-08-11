import { type AgentConfig } from '@agent/core/definition/AgentConfig';
import { type TaskState } from '@agent/core/state/TaskState';
import { AgentCategory } from '@shared/schemas';

/**
 * Project a run config into the frozen CLI NDJSON `setTaskState` payload. This
 * is the projection's only remaining purpose: every other surface reads
 * `AgentConfig` directly, so the wire shape stays byte-identical without a
 * `TaskState` vocabulary living beside it.
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
