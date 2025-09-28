// Local imports - logger
import type { ToolUseTaskState } from '@logger/TaskState';

// Local imports - progress view
import { BaseTaskStateManager } from './BaseTaskStateManager';

/**
 * Maintains task state for tool-use sessions separately from workflow runs.
 */
export class ToolUseTaskStateManager extends BaseTaskStateManager<ToolUseTaskState> {
  protected cloneState(state: ToolUseTaskState): ToolUseTaskState {
    return {
      ...state,
      agentConfig: { ...state.agentConfig },
      toolSessionState: state.toolSessionState
        ? { ...state.toolSessionState }
        : undefined,
    };
  }
}
