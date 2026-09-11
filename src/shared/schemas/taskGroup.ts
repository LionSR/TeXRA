import { z } from 'zod';

import { TaskGroupStatusSchema } from './run';

export const StageKindSchema = z.enum(['run', 'round', 'phase', 'session']);

/** Shared by `TaskGroupSchema` and `GroupLogPayloadSchema` below. */
const taskGroupIndexField = z.int().nonnegative();
const taskGroupTotalField = z.int().positive();
const taskGroupEndTimeField = z.number();

export const TaskGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  startTime: z.number(),
  endTime: taskGroupEndTimeField.optional(),
  status: TaskGroupStatusSchema,
  parentGroupId: z.string().optional(),
  kind: StageKindSchema.optional(),
  /** Workflow-script projection attempt that opened this phase. */
  attemptId: z.string().min(1).optional(),
  index: taskGroupIndexField.optional(),
  total: taskGroupTotalField.optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;

/**
 * Shape of `StreamLogEntry.data` on `group-start`/`group-end` entries: a
 * partial `TaskGroup` (only the fields the producer chose to send this
 * update). Single source of truth for the host-neutral task-group projection
 * (`shared/runs/taskGroupProjection.ts`), which otherwise would re-derive
 * `status`/`kind` membership with hand-rolled type guards duplicating
 * `TaskGroupStatusSchema`/`StageKindSchema`.
 *
 * `status` is the native `TaskGroupStatus` — the `RunPhase`
 * running/completed/cancelled/failed subset every live and persisted
 * `group-start`/`group-end` producer writes. A value outside that vocabulary
 * is rejected at the parse boundary.
 */
const groupLogPayloadFields = {
  status: TaskGroupStatusSchema.optional(),
  kind: StageKindSchema.optional(),
  attemptId: z.string().min(1).optional(),
  index: taskGroupIndexField.optional(),
  total: taskGroupTotalField.optional(),
  name: z.string().optional(),
  endTime: taskGroupEndTimeField.optional(),
};

export const GroupLogPayloadSchema = z.looseObject(groupLogPayloadFields);
