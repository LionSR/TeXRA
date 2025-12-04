/**
 * Zod schemas for ProgressEventBus payloads.
 *
 * These schemas provide runtime validation for event payloads.
 * Types are derived from schemas for single source of truth.
 *
 * Note: Some payloads (SetActiveStreamPayload, SetTaskStatePayload) are
 * defined inline in ProgressEventBus.ts because they reference types
 * (AgentSessionDescriptor, TaskState) that don't have schemas yet.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - schemas
import {
  StreamTabIdSchema,
  ExecutionIdSchema,
  StorageKeySchema,
} from '@agent/types/IdentifierTypes';

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
