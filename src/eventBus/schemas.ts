/**
 * Zod schemas for ProgressEventBus payloads.
 * Types are derived from schemas for single source of truth.
 */
import { z } from 'zod';
import { AgentCategory } from '@agent/core/AgentDataclass';
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
import { TaskStateSchema, type TaskState } from '@logger/TaskState';

/**
 * Re-export from types.ts to break circular dependency:
 * progressView/events → eventBus/schemas → eventBus/types
 * (progressView cannot import types.ts directly due to other deps)
 */
export {
  ToolEditApprovalPromptSchema,
  RetryRequestPromptSchema,
  WorkflowAgentProposalSchema,
  WorkflowAgentProposalPromptSchema,
  type ToolEditApprovalPrompt,
  type RetryRequestPrompt,
  type WorkflowAgentProposal,
  type WorkflowAgentProposalPrompt,
} from './types';

// Re-export error types from the canonical location
export {
  ProviderErrorPartialSchema,
  type ProviderErrorPartial,
} from '@common/errors/schemas';

// Re-export TaskGroupStatusSchema from single source of truth
export { TaskGroupStatusSchema, type TaskGroupStatus };

/**
 * Payload for adding a new task group.
 * Uses TaskGroupSchema fields directly - no field renaming to avoid mapping overhead.
 */
export const AddTaskGroupPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  ...TaskGroupSchema.shape,
});
export type AddTaskGroupPayload = z.infer<typeof AddTaskGroupPayloadSchema>;

/** Payload for updating a task group (subset of AddTaskGroupPayload) */
export const UpdateTaskGroupPayloadSchema = AddTaskGroupPayloadSchema.pick({
  streamId: true,
  id: true,
  status: true,
  endTime: true,
});
export type UpdateTaskGroupPayload = z.infer<
  typeof UpdateTaskGroupPayloadSchema
>;

/** Base payload for storage-scoped events (files, usage, etc.) */
export const RunScopedPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  storageKey: StorageKeySchema,
  executionId: ExecutionIdSchema.optional(),
});
export type RunScopedPayload = z.infer<typeof RunScopedPayloadSchema>;

/** Todo status values - single source of truth for todo item states. */
const todoStatusValues = ['pending', 'in_progress', 'completed'] as const;

/** Todo status constants for programmatic access. */
export const TODO_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const satisfies Record<string, (typeof todoStatusValues)[number]>;

/** Status of a todo item */
export const TodoStatusSchema = z
  .enum(todoStatusValues)
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
  streamId: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});
export type UpdateTodosPayload = z.infer<typeof UpdateTodosPayloadSchema>;

// =============================================================================
// Stream State Payloads
// =============================================================================

/** Payload for setting the active stream with optional category hint */
export const SetActiveStreamPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema.nullable(),
  agentCategory: z.nativeEnum(AgentCategory).optional(),
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote: z.boolean().optional(),
  /** Hint whether this agent uses multiple outputs (for UI display before TaskState is set) */
  hasMultipleOutputs: z.boolean().optional(),
});
export type SetActiveStreamPayload = z.infer<
  typeof SetActiveStreamPayloadSchema
>;

/**
 * Payload for setting task state on a stream.
 *
 * TaskStateSchema uses looseObject for validation efficiency (only validates
 * discriminator fields), while the full TaskState type has all AgentConfig fields.
 * We use pipe() to validate structure then cast to the full type, preserving
 * error messages from the underlying schema.
 */
export const SetTaskStatePayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  // Validate with TaskStateSchema, then cast output to full TaskState type
  taskState: TaskStateSchema.pipe(z.custom<TaskState>(() => true)),
});
export type SetTaskStatePayload = z.infer<typeof SetTaskStatePayloadSchema>;
