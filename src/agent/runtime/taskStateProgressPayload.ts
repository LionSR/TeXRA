import type { TaskState } from '@agent/core/state/TaskState';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export interface SetTaskStatePayload {
  streamId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
}
