/**
 * Zod schemas for ProgressEventBus payloads.
 * Types are derived from schemas for single source of truth.
 */
import { z } from 'zod';
import {
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
} from '@agent/types/IdentifierTypes';
import {
  TaskGroupStatusSchema,
  type TaskGroupStatus,
} from '@common/constants/streamStatus';
import { TaskGroupSchema } from '@logger/LogTypes';

/**
 * Re-export from types.ts to break circular dependency:
 * progressView/events → eventBus/schemas → eventBus/types
 * (progressView cannot import types.ts directly due to other deps)
 */
export {
  ToolEditApprovalPromptSchema,
  RetryRequestPromptSchema,
  type ToolEditApprovalPrompt,
  type RetryRequestPrompt,
} from './types';

// Re-export TaskGroupStatusSchema from single source of truth
export { TaskGroupStatusSchema, type TaskGroupStatus };

/**
 * Payload for adding a new task group.
 * Uses TaskGroupSchema fields directly - no field renaming to avoid mapping overhead.
 */
export const AddTaskGroupPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  ...TaskGroupSchema.shape,
});
export type AddTaskGroupPayload = z.infer<typeof AddTaskGroupPayloadSchema>;

/** Payload for updating a task group (subset of AddTaskGroupPayload) */
export const UpdateTaskGroupPayloadSchema = AddTaskGroupPayloadSchema.pick({
  stream: true,
  id: true,
  status: true,
  endTime: true,
});
export type UpdateTaskGroupPayload = z.infer<
  typeof UpdateTaskGroupPayloadSchema
>;

/** Base payload for storage-scoped events (files, usage, etc.) */
export const RunScopedPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  storageKey: StorageKeySchema,
  executionId: ExecutionIdSchema.optional(),
});
export type RunScopedPayload = z.infer<typeof RunScopedPayloadSchema>;

/**
 * Todo status constants - single source of truth for todo item states.
 * Used by tool-use agents for task tracking.
 */
export const TODO_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const;

/** Status of a todo item */
export const TodoStatusSchema = z
  .enum([TODO_STATUS.PENDING, TODO_STATUS.IN_PROGRESS, TODO_STATUS.COMPLETED])
  .describe('Current status of the task');
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

/** Schema for a single todo item (single source of truth for all todo schemas) */
export const TodoItemSchema = z.strictObject({
  /** The task description in imperative form */
  content: z.string().min(1).describe('Task description in imperative form'),
  /** Current status of the task */
  status: TodoStatusSchema,
  /** Present continuous form shown during execution */
  activeForm: z
    .string()
    .min(1)
    .describe('Present continuous form for display during execution'),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

/** Payload for updating todos in a stream */
export const UpdateTodosPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  todos: z.array(TodoItemSchema),
});
export type UpdateTodosPayload = z.infer<typeof UpdateTodosPayloadSchema>;
