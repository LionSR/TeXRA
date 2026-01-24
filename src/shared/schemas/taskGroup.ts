// Third-party imports
import { z } from 'zod';

// Local imports
import { StreamTabIdSchema } from './identifiers';
import { TaskGroupStatusSchema } from './stream';

/**
 * Task group schema - single source of truth for task group structure.
 * Used by logger and progress view for tracking execution groups.
 */
export const TaskGroupSchema = z.strictObject({
  /** Unique identifier for the group */
  id: z.string().min(1),
  /** Display name of the group */
  name: z.string(),
  /** Unix timestamp (ms) when the group started */
  startTime: z.number(),
  /** Unix timestamp (ms) when the group ended */
  endTime: z.number().optional(),
  /** Current status of the group */
  status: TaskGroupStatusSchema,
  /** Parent group ID for nested groups */
  parentGroupId: z.string().optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;

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
