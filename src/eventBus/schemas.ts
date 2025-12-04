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
import type { TaskGroup } from '@logger/LogTypes';

// Re-export from types.ts (breaking circular dependency with progressView)
export {
  ToolEditApprovalPromptSchema,
  RetryRequestPromptSchema,
  type ToolEditApprovalPrompt,
  type RetryRequestPrompt,
} from './types';

/** Task group status - derived from TaskGroup['status'] */
export const TaskGroupStatusSchema = z.enum([
  'running',
  'error',
  'stopped',
  'ready',
]);
export type TaskGroupStatus = z.infer<typeof TaskGroupStatusSchema>;

// Compile-time assertion: ensures TaskGroupStatus stays in sync with LogTypes
type _AssertStatusMatch = TaskGroupStatus extends TaskGroup['status']
  ? TaskGroup['status'] extends TaskGroupStatus
    ? true
    : never
  : never;
const _assertStatusMatch: _AssertStatusMatch = true;
void _assertStatusMatch;

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
