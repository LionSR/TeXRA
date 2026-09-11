import { z } from 'zod';

import { RunIdSchema } from './identifiers';
import {
  TERMINAL_WORKFLOW_CALL_STATUSES,
  WORKFLOW_CALL_KIND,
  WORKFLOW_CALL_STATUS,
  WorkflowCallFilesSchema,
  type WorkflowCallStatus,
} from './workflowRunSnapshot';

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
 * transcript when the attempt's run state is constructed. Phases and
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
  costUsd: z.number().nonnegative().optional(),
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
   * The live child run executing this call. Absent for planned, cached, and
   * not-yet-launched calls.
   */
  childRunId: RunIdSchema.optional(),
});

/**
 * Canonical state of one declared or dynamically issued workflow-script call.
 * The status discriminant prevents terminal-only metadata from appearing on a
 * call that has not started.
 */
const WorkflowCallSkippedProgressSchema = z.discriminatedUnion('reason', [
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.SKIPPED),
    reason: z.literal('not-reached'),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.SKIPPED),
    reason: z.literal('user'),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

/** The card projection of a persisted call; same status vocabulary. */
export const WorkflowCallProgressSchema = z.discriminatedUnion('status', [
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.DECLARED),
  }),
  /** Issued by the script; not yet queued for a concurrency slot. */
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.PLANNED),
  }),
  /** Issued and waiting for one of the run's concurrency slots. */
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.QUEUED),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.RUNNING),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.COMPLETED),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.CACHED),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.CANCELLED),
    // Cancelled is terminal but not a failure, so it intentionally omits the
    // `error` field carried by `failed`; renderers surface it as a stopped
    // state rather than as an exception.
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallSkippedProgressSchema,
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.FAILED),
    error: z.string().min(1),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

export type WorkflowCallProgress = z.infer<typeof WorkflowCallProgressSchema>;
type WorkflowCallLiveStatus = Exclude<
  WorkflowCallStatus,
  'completed' | 'cached' | 'cancelled' | 'skipped' | 'failed'
>;
export type WorkflowCallTerminalProgress = Exclude<
  WorkflowCallProgress,
  { readonly status: WorkflowCallLiveStatus }
>;
/** A call that has not reached a terminal status — the sweep's subject. */
export type WorkflowCallLiveProgress = Extract<
  WorkflowCallProgress,
  { readonly status: WorkflowCallLiveStatus }
>;

/** One lifecycle predicate shared by persistence and transcript projections. */
export function isTerminalWorkflowCallStatus(
  status: WorkflowCallStatus,
): status is WorkflowCallTerminalProgress['status'] {
  return TERMINAL_WORKFLOW_CALL_STATUSES.has(status);
}

export function isTerminalWorkflowCallProgress(
  call: WorkflowCallProgress,
): call is WorkflowCallTerminalProgress {
  return isTerminalWorkflowCallStatus(call.status);
}

/** What a call that was in flight when its host stopped says about itself. */
const INTERRUPTED_WORKFLOW_CALL_ERROR =
  'The previous host stopped before this call completed.';

/**
 * How a host that stopped mid-run leaves one unsettled call — the single
 * vocabulary for an interrupted card.
 *
 * Both settlements use this vocabulary: host exit publishes a canonical
 * workflow.call fact, and workflowRunModel repaints a durably final run when
 * a crash or expired deadline prevented that publication. Replay and the
 * read-time view therefore describe the interrupted call consistently.
 */
export function interruptedWorkflowCall(
  call: WorkflowCallLiveProgress,
): WorkflowCallTerminalProgress {
  // Only a running call had model work in flight; a declared, planned, or
  // queued call was never launched.
  return call.status === 'running'
    ? { ...call, status: 'failed', error: INTERRUPTED_WORKFLOW_CALL_ERROR }
    : { ...call, status: 'skipped', reason: 'not-reached' };
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
} as const satisfies Record<WorkflowCallStatus, string>;
