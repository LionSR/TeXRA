import { z } from 'zod';

import { RunOutcomeSchema, TaskGroupStatusSchema } from './stream';

export const StageKindSchema = z.enum(['run', 'round', 'phase', 'session']);
export type StageKind = z.infer<typeof StageKindSchema>;

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
  index: taskGroupIndexField.optional(),
  total: taskGroupTotalField.optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;

/**
 * Shape of `StreamLogEntry.data` on `group-start`/`group-end` entries: a
 * partial `TaskGroup` (only the fields the producer chose to send this
 * update). Single source of truth for the frontend's group-tracking reducer
 * (`logSlice.ts`), which previously re-derived `status`/`kind` membership
 * with hand-rolled type guards duplicating `TaskGroupStatusSchema`/
 * `StageKindSchema`.
 *
 * Each field validates (and recovers via `.catch(undefined)`) independently
 * so one invalid field — e.g. an unrecognized `status` from an older/newer
 * producer — doesn't fail the whole payload and drop sibling fields that
 * were otherwise usable; the old per-field guards had this per-field
 * tolerance and a single `.safeParse()` on a non-catching schema would not.
 *
 * `status` accepts both vocabularies a wire row can carry: the legacy
 * `TaskGroupStatus` a `group-start` row (and a pre-#7993 `group-end` row
 * forwarded raw by the standalone trace-viewer) uses, and the canonical
 * `RunOutcome` every live/persisted `group-end` producer now writes.
 * `logSlice.ts` folds a `RunOutcome` down to the legacy bucket at the point
 * it needs `TaskGroupStatus` (`taskGroupEndStatus`); a value in neither
 * vocabulary still falls back to `undefined` here, same as any other field.
 */
export const GroupLogPayloadSchema = z.looseObject({
  status: z
    .union([TaskGroupStatusSchema, RunOutcomeSchema])
    .optional()
    .catch(undefined),
  kind: StageKindSchema.optional().catch(undefined),
  index: taskGroupIndexField.optional().catch(undefined),
  total: taskGroupTotalField.optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  endTime: taskGroupEndTimeField.optional().catch(undefined),
});
export type GroupLogPayload = z.infer<typeof GroupLogPayloadSchema>;
