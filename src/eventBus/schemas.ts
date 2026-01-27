import { z } from 'zod';

import {
  ExecutionIdSchema,
  StorageKeySchema,
  StreamTabIdSchema,
} from '@shared/schemas';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { TaskStateSchema, type TaskState } from '@logger/TaskState';

// Re-export payload types from shared schemas for ProgressEventBus
export type {
  AddTaskGroupPayload,
  UpdateTaskGroupPayload,
  UpdateTodosPayload,
} from '@shared/schemas';

export const RunScopedPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  storageKey: StorageKeySchema,
  executionId: ExecutionIdSchema.optional(),
});
export type RunScopedPayload = z.infer<typeof RunScopedPayloadSchema>;

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

export const SetTaskStatePayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  taskState: TaskStateSchema.transform((v): TaskState => v as TaskState),
});
export type SetTaskStatePayload = z.infer<typeof SetTaskStatePayloadSchema>;
