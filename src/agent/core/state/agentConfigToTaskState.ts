import { AgentCategory } from '@shared/schemas';

import { type AgentConfig } from '../definition/AgentConfig';
import { type TaskState } from './TaskState';

/**
 * Project a run config into the frozen CLI NDJSON `setTaskState` payload. This
 * is the projection's only remaining purpose: every other surface reads
 * `AgentConfig` directly, so the wire shape stays byte-identical without a
 * `TaskState` vocabulary living beside it.
 */
export function agentConfigToTaskState(config: AgentConfig): TaskState {
  switch (config.agentCategory) {
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
      const _exhaustive: never = config.agentCategory;
      throw new Error(`Unknown agent category: ${String(_exhaustive)}`);
    }
  }
}
