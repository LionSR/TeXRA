// Local imports - logger
import type { WorkflowTaskState } from '@logger/TaskState';

// Local imports - progress view
import { BaseTaskStateManager } from './BaseTaskStateManager';

/**
 * Stores workflow task state keyed by stream identifier.
 */
export class WorkflowTaskStateManager extends BaseTaskStateManager<WorkflowTaskState> {
  protected cloneState(state: WorkflowTaskState): WorkflowTaskState {
    return {
      ...state,
      agentConfig: { ...state.agentConfig },
      activeFiles: { ...state.activeFiles },
    };
  }
}
