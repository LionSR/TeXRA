import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';
import {
  WORKFLOW_CALL_KIND,
  WorkflowCallFilesSchema,
} from './workflowExecutionSnapshot';

export const WorkflowCallIdentitySchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .describe('Stable identity for one workflow-script agent call.'),
  label: z
    .string()
    .trim()
    .min(1)
    .describe('Human-readable call name shown on progress surfaces.'),
  phase: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional declared workflow phase containing the call.'),
});
export type WorkflowCallIdentity = z.infer<typeof WorkflowCallIdentitySchema>;

/**
 * The declared shape of a workflow script — `meta.phases` in order and
 * `meta.tasks` — as both the approval proposal and the plan marker carry it.
 * A phase's position is its index in the array.
 */
export const WorkflowDeclaredPlanSchema = z.strictObject({
  phases: z.array(z.strictObject({ title: z.string().min(1) })),
  tasks: z.array(WorkflowCallIdentitySchema),
});
export type WorkflowDeclaredPlan = z.infer<typeof WorkflowDeclaredPlanSchema>;

/**
 * The declared plan of one workflow-script attempt — every `meta.phases`
 * entry and every `meta.tasks` entry, in script order — recorded once on the
 * transcript when the attempt's execution state is constructed. Phases and
 * calls the run has reached are projected as stages and cards; this marker is
 * what lets a host list the ones it has not reached yet without opening their
 * stage (a `stage.start` prints the phase divider into scrollback).
 */
export const WorkflowPlanMarkerSchema = WorkflowDeclaredPlanSchema.extend({
  kind: z.literal('workflowPlan'),
  attemptId: z.string().min(1),
});
export type WorkflowPlanMarker = z.infer<typeof WorkflowPlanMarkerSchema>;

const WorkflowCallTerminalMetadataSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
});

const WorkflowCallProgressBaseSchema = WorkflowCallIdentitySchema.extend({
  /**
   * Facts of the actual `agent()` invocation, present once the script issues
   * the call: its result contract, the agent and model it runs (declared by
   * the script, then host-resolved), and the file basenames it was handed.
   * A declared plan label carries none of them.
   */
  kind: z.enum(WORKFLOW_CALL_KIND).optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  files: WorkflowCallFilesSchema.optional(),
  /**
   * Physical attempt number of this call across interactive retries and
   * durable resumes (hydration keeps prior attempts), present from the second
   * attempt on. Distinct from `attemptId`, the whole-script projection
   * attempt. The label is never rewritten to say "retry".
   */
  attemptNumber: z.int().min(2).optional(),
  /**
   * Physical workflow-script projection attempt. All progress records from one
   * run share this id; older persisted transcripts may omit it. A malformed
   * present value must fail parsing: treating corrupted attempt ownership as
   * absent could mix a prior run's task into the current live projection.
   */
  attemptId: z.string().min(1).optional(),
  /**
   * Live child stream that executes this call. Absent for planned, cached, and
   * not-yet-launched calls.
   */
  childStreamId: StreamTabIdSchema.optional(),
});

/**
 * Canonical state of one declared or dynamically issued workflow-script call.
 * The status discriminant prevents terminal-only metadata from appearing on a
 * call that has not started.
 */
const WorkflowCallSkippedProgressSchema = z.discriminatedUnion('reason', [
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('skipped'),
    reason: z.literal('not-reached'),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('skipped'),
    reason: z.literal('user'),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

export const WorkflowCallProgressSchema = z.discriminatedUnion('status', [
  /** A `meta.tasks` plan label the script has not issued as a call. */
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('declared'),
  }),
  /** Issued by the script; not yet queued for a concurrency slot. */
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('planned'),
  }),
  /** Issued and waiting for one of the run's concurrency slots. */
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('queued'),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('running'),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('completed'),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('cached'),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('cancelled'),
    // Cancelled is terminal but not a failure, so it intentionally omits the
    // `error` field carried by `failed`; renderers surface it as a stopped
    // state rather than as an exception.
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallSkippedProgressSchema,
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('failed'),
    error: z.string().min(1),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

export type WorkflowCallProgress = z.infer<typeof WorkflowCallProgressSchema>;
type WorkflowCallLiveStatus = 'declared' | 'planned' | 'queued' | 'running';
export type WorkflowCallTerminalProgress = Exclude<
  WorkflowCallProgress,
  { readonly status: WorkflowCallLiveStatus }
>;

/** One lifecycle predicate shared by persistence and transcript projections. */
export function isTerminalWorkflowCallStatus(
  status: WorkflowCallProgress['status'],
): status is WorkflowCallTerminalProgress['status'] {
  switch (status) {
    case 'declared':
    case 'planned':
    case 'queued':
    case 'running':
      return false;
    case 'completed':
    case 'cached':
    case 'cancelled':
    case 'skipped':
    case 'failed':
      return true;
  }
}

export function isTerminalWorkflowCallProgress(
  call: WorkflowCallProgress,
): call is WorkflowCallTerminalProgress {
  return isTerminalWorkflowCallStatus(call.status);
}

export const WORKFLOW_TASK_STATUS_LABEL = {
  declared: 'Declared',
  planned: 'Planned',
  queued: 'Queued',
  running: 'Running',
  completed: 'Finished',
  cached: 'Saved result',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  failed: 'Failed',
} as const satisfies Record<WorkflowCallProgress['status'], string>;
