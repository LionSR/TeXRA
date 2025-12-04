/**
 * Zod schemas for ProgressEventBus payloads.
 *
 * These schemas provide runtime validation for event payloads.
 * Types are derived from schemas for single source of truth.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - schemas
import {
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
} from '@agent/types/IdentifierTypes';
import { StreamStatusSchema } from '@common/constants/streamStatus';

// Re-export for convenience
export {
  ToolEditApprovalPromptSchema,
  RetryRequestPromptSchema,
  type ToolEditApprovalPrompt,
  type RetryRequestPrompt,
} from './types';

// ============================================================================
// TASK GROUP SCHEMAS
// ============================================================================

/**
 * Valid task group status values.
 * Matches TaskGroup['status'] from LogTypes.
 */
export const TaskGroupStatusSchema = z.enum([
  'running',
  'error',
  'stopped',
  'ready',
]);
export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

/**
 * Payload for adding a new task group.
 */
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

/**
 * Payload for updating an existing task group.
 */
export const UpdateTaskGroupPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  groupId: z.string().min(1),
  status: TaskGroupStatusSchema,
  endTime: z.number().optional(),
});
export type UpdateTaskGroupPayload = z.infer<
  typeof UpdateTaskGroupPayloadSchema
>;

// ============================================================================
// STREAM SCHEMAS
// ============================================================================

/**
 * Payload for setting the active stream.
 * session is typed loosely here; full validation happens in consumers.
 */
export const SetActiveStreamPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema.nullable(),
  session: z.unknown().nullish(),
});
export type SetActiveStreamPayload = z.infer<
  typeof SetActiveStreamPayloadSchema
>;

/**
 * Payload for updating stream status.
 */
export const UpdateStreamStatusPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  status: StreamStatusSchema,
});
export type UpdateStreamStatusPayload = z.infer<
  typeof UpdateStreamStatusPayloadSchema
>;

// ============================================================================
// TASK STATE SCHEMAS
// ============================================================================

/**
 * Payload for setting task state.
 * taskState is typed loosely here; full validation happens in consumers.
 */
export const SetTaskStatePayloadSchema = z.strictObject({
  streamTabId: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  taskState: z.unknown(),
});
export type SetTaskStatePayload = z.infer<typeof SetTaskStatePayloadSchema>;

// ============================================================================
// RUN-SCOPED SCHEMAS
// ============================================================================

/**
 * Base payload for storage-scoped events (files, usage, etc.).
 * storageKey is THE key for storage operations - required for all events.
 */
export const RunScopedPayloadSchema = z.strictObject({
  stream: StreamTabIdSchema,
  /** THE key for storage operations. Required. */
  storageKey: StorageKeySchema,
  /** For metadata/audit purposes */
  executionId: ExecutionIdSchema.optional(),
});
export type RunScopedPayload = z.infer<typeof RunScopedPayloadSchema>;

// ============================================================================
// SIMPLE EVENT SCHEMAS
// ============================================================================

/**
 * Payload for resolving retry requests.
 */
export const ResolveRetryRequestPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
});
export type ResolveRetryRequestPayload = z.infer<
  typeof ResolveRetryRequestPayloadSchema
>;

/**
 * Payload for resolving tool edit approval prompts.
 */
export const ResolveToolEditApprovalPayloadSchema = z.strictObject({
  requestId: z.string().min(1),
});
export type ResolveToolEditApprovalPayload = z.infer<
  typeof ResolveToolEditApprovalPayloadSchema
>;

/**
 * Payload for updating tool edit approval bypass state.
 */
export const UpdateToolEditApprovalBypassPayloadSchema = z.strictObject({
  bypassActive: z.boolean(),
});
export type UpdateToolEditApprovalBypassPayload = z.infer<
  typeof UpdateToolEditApprovalBypassPayloadSchema
>;
