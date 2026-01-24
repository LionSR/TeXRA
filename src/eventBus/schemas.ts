/**
 * Zod schemas for ProgressEventBus payloads.
 * Types are derived from schemas for single source of truth.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentCategory } from '@agent/core/AgentDataclass';

// Local imports - shared schemas
import {
  ExecutionIdSchema,
  StorageKeySchema,
  StreamTabIdSchema,
  TodoItemSchema,
} from '@shared/schemas';

// Local imports - logger
import { TaskStateSchema, type TaskState } from '@logger/TaskState';

/** Base payload for storage-scoped events (files, usage, etc.) */
export const RunScopedPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  storageKey: StorageKeySchema,
  executionId: ExecutionIdSchema.optional(),
});
export type RunScopedPayload = z.infer<typeof RunScopedPayloadSchema>;

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
  agentCategory: z.enum(AgentCategory).optional(),
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
