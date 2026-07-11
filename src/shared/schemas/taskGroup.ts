import { z } from 'zod';

import { TaskGroupStatusSchema } from './stream';

export const StageKindSchema = z.enum(['run', 'round', 'phase', 'session']);
export type StageKind = z.infer<typeof StageKindSchema>;

export const TaskGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  status: TaskGroupStatusSchema,
  parentGroupId: z.string().optional(),
  kind: StageKindSchema.optional(),
  index: z.int().nonnegative().optional(),
  total: z.int().positive().optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;

/**
 * Shape of `StreamLogEntry.data` on `group-start`/`group-end` entries: a
 * partial `TaskGroup` (only the fields the producer chose to send this
 * update). Single source of truth for the frontend's group-tracking reducer
 * (`logSlice.ts`), which previously re-derived `status`/`kind` membership
 * with hand-rolled type guards duplicating `TaskGroupStatusSchema`/
 * `StageKindSchema`.
 */
export const GroupLogPayloadSchema = z.looseObject({
  status: TaskGroupStatusSchema.optional(),
  kind: StageKindSchema.optional(),
  index: z.number().optional(),
  total: z.number().optional(),
  name: z.string().optional(),
  endTime: z.number().optional(),
});
export type GroupLogPayload = z.infer<typeof GroupLogPayloadSchema>;
