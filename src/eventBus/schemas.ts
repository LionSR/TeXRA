import { AgentCategory } from '@agent/core/AgentDataclass';
import type { TaskState } from '@logger/TaskState';
import type {
  AddTaskGroupPayload,
  ExecutionId,
  StorageKey,
  StreamTabId,
  UpdateTaskGroupPayload,
  UpdateTodosPayload,
} from '@shared/schemas';

// Re-export payload types from shared schemas for ProgressEventBus
export type { AddTaskGroupPayload, UpdateTaskGroupPayload, UpdateTodosPayload };

/**
 * Payload for events scoped to a specific run (stream + storage key).
 * Note: These types are not validated at runtime - they're compile-time only.
 */
export interface RunScopedPayload {
  streamId: StreamTabId;
  storageKey: StorageKey;
  executionId?: ExecutionId;
}

export interface SetActiveStreamPayload {
  streamId: StreamTabId | null;
  agentCategory?: AgentCategory;
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote?: boolean;
  /** Hint whether this agent uses multiple outputs (for UI display before TaskState is set) */
  hasMultipleOutputs?: boolean;
}

export interface SetTaskStatePayload {
  streamId: StreamTabId;
  executionId?: ExecutionId;
  taskState: TaskState;
}
