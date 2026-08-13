import { z } from 'zod';

import { EndGroupStatusSchema } from './log';
import { TaskGroupStatusSchema } from './stream';

const StageKindSchema = z.enum(['run', 'round', 'phase', 'session']);

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
 * update). Single source of truth for the host-neutral task-group projection
 * (`shared/streams/taskGroupProjection.ts`), which otherwise would re-derive
 * `status`/`kind` membership with hand-rolled type guards duplicating
 * `TaskGroupStatusSchema`/`StageKindSchema`.
 *
 * Each field validates (and recovers via `.catch(undefined)`) independently
 * so one invalid field — e.g. an unrecognized `status` from an older/newer
 * producer — doesn't fail the whole payload and drop sibling fields that
 * were otherwise usable; the old per-field guards had this per-field
 * tolerance and a single `.safeParse()` on a non-catching schema would not.
 *
 * `status` accepts both vocabularies a wire row can still carry post-#7993
 * step 3: the native `TaskGroupStatus` (the `StreamPhase` running/completed/
 * cancelled/failed subset) every live/persisted `group-start`/`group-end`
 * producer writes, and the legacy 2-value `EndGroupStatus` ('stopped'/
 * 'error') a pre-cutover exported trace file's raw entries still carry —
 * the standalone trace-viewer's `replayTrace()` forwards `trace.entries`
 * verbatim into this same `LOG_DELTA` pipeline, a permanent second boundary
 * (docs/proposals/2026-07-03-session-scoped-runtime-architecture.md §8.3). Now that
 * `TaskGroupStatus` is itself retyped to the native vocabulary, `RunOutcome`
 * is a strict subset of it and needs no separate union member; only the
 * still-disjoint legacy `EndGroupStatus` vocabulary does. The shared
 * projection maps a legacy value UP to the native value it corresponds to;
 * a value in neither vocabulary still falls back to `undefined` here, same
 * as any other field.
 */
export const GroupLogPayloadSchema = z.looseObject({
  status: z
    .union([TaskGroupStatusSchema, EndGroupStatusSchema])
    .optional()
    .catch(undefined),
  kind: StageKindSchema.optional().catch(undefined),
  index: taskGroupIndexField.optional().catch(undefined),
  total: taskGroupTotalField.optional().catch(undefined),
  attemptId: z.string().min(1).optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  endTime: taskGroupEndTimeField.optional().catch(undefined),
});
