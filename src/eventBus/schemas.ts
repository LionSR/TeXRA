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

/** Payload for adding a new task group */
export const AddTaskGroupPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  groupId: z.string().min(1),
  groupName: z.string(),
  startTime: z.number(),
  status: TaskGroupStatusSchema,
  endTime: z.number().optional(),
  parentGroupId: z.string().optional(),
});
export type AddTaskGroupPayload = z.infer<typeof AddTaskGroupPayloadSchema>;

/** Payload for updating a task group (subset of AddTaskGroupPayload) */
export const UpdateTaskGroupPayloadSchema = AddTaskGroupPayloadSchema.pick({
  stream: true,
  groupId: true,
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

/** Status of a todo item */
export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

/** Schema for a single todo item */
export const TodoItemSchema = z.strictObject({
  /** The task description in imperative form */
  content: z.string().min(1),
  /** Current status of the task */
  status: TodoStatusSchema,
  /** Present continuous form shown during execution */
  activeForm: z.string().min(1),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

/** Payload for updating todos in a stream */
export const UpdateTodosPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  todos: z.array(TodoItemSchema),
});
export type UpdateTodosPayload = z.infer<typeof UpdateTodosPayloadSchema>;
