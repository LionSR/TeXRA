import { z } from 'zod';

import { EndGroupStatusSchema } from './log';
import { TaskGroupStatusSchema } from './stream';

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
 * (`shared/streams/taskGroupProjection.ts`), which otherwise would re-derive
 * `status`/`kind` membership with hand-rolled type guards duplicating
 * `TaskGroupStatusSchema`/`StageKindSchema`.
 *
 * `status` accepts both vocabularies a wire row can still carry post-#7993
 * step 3: the native `TaskGroupStatus` (the `StreamPhase` running/completed/
 * cancelled/failed subset) every live/persisted `group-start`/`group-end`
 * producer writes, and the legacy 2-value `EndGroupStatus` ('stopped'/
 * 'error') a pre-cutover exported trace file's raw entries still carry:
 * the standalone trace-viewer frames `trace.entries` verbatim into the
 * same fold, a permanent second boundary
 * (agents/docs/archived/architecture/2026-07-03-session-scoped-runtime-architecture.md §8.3). Now that
 * `TaskGroupStatus` is itself retyped to the native vocabulary, `RunOutcome`
 * is a strict subset of it and needs no separate union member; only the
 * still-disjoint legacy `EndGroupStatus` vocabulary does. The shared
 * projection maps a legacy value UP to the native value it corresponds to;
 * a value in neither vocabulary is rejected at the canonical persistence
 * boundary. Exported traces recover stale display fields independently in
 * `TraceGroupLogPayloadSchema`.
 */
const groupLogPayloadFields = {
  status: z.union([TaskGroupStatusSchema, EndGroupStatusSchema]).optional(),
  kind: StageKindSchema.optional(),
  attemptId: z.string().min(1).optional(),
  index: taskGroupIndexField.optional(),
  total: taskGroupTotalField.optional(),
  name: z.string().optional(),
  endTime: taskGroupEndTimeField.optional(),
};

export const GroupLogPayloadSchema = z.looseObject(groupLogPayloadFields);

/**
 * Permanent exported-trace recovery for group rows written by older versions.
 * Display-only fields recover independently so one stale value does not
 * discard the whole trace entry. Attempt ownership is lifecycle identity, not
 * display data: an invalid present value rejects the entry rather than being
 * mistaken for a compatible legacy omission.
 */
export const TraceGroupLogPayloadSchema = z.looseObject({
  ...groupLogPayloadFields,
  status: groupLogPayloadFields.status.catch(undefined),
  kind: groupLogPayloadFields.kind.catch(undefined),
  attemptId: groupLogPayloadFields.attemptId,
  index: groupLogPayloadFields.index.catch(undefined),
  total: groupLogPayloadFields.total.catch(undefined),
  name: groupLogPayloadFields.name.catch(undefined),
  endTime: groupLogPayloadFields.endTime.catch(undefined),
});
