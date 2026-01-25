/**
 * Zod schemas for ProgressEventBus payloads.
 * Types are derived from schemas for single source of truth.
 */
import { z } from 'zod';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  AddTaskGroupPayloadSchema,
  UpdateTaskGroupPayloadSchema,
  UpdateTodosPayloadSchema,
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
} from '@shared/schemas';
import { TaskStateSchema, type TaskState } from '@logger/TaskState';

/**
 * Re-export shared prompt/error schemas so ProgressEventBus can depend on one source.
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
  ProviderErrorPartialSchema,
  type ProviderErrorPartial,
  type TaskGroupStatus,
  type TodoStatus,
  type TodoItem,
} from '@shared/schemas';

/**
 * Payload for adding a new task group.
 * Uses TaskGroupSchema fields directly - no field renaming to avoid mapping overhead.
 */
export type AddTaskGroupPayload = z.infer<typeof AddTaskGroupPayloadSchema>;
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

export { TODO_STATUS } from '@shared/schemas';
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
 * We use transform() to validate structure then cast to the full type.
 */
export const SetTaskStatePayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  // Validate with TaskStateSchema, then cast output to full TaskState type
  taskState: TaskStateSchema.transform((v): TaskState => v as TaskState),
});
export type SetTaskStatePayload = z.infer<typeof SetTaskStatePayloadSchema>;
