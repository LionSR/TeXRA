import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';

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

/** Durable boundary between physical runs appended to one workflow stream. */
export const WorkflowAttemptMarkerSchema = z.strictObject({
  kind: z.literal('workflowAttempt'),
  attemptId: z.string().min(1),
});
export type WorkflowAttemptMarker = z.infer<typeof WorkflowAttemptMarkerSchema>;

const WorkflowCallTerminalMetadataSchema = z.strictObject({
  model: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
});

const WorkflowCallProgressBaseSchema = WorkflowCallIdentitySchema.extend({
  /**
   * Physical workflow-script projection attempt. All progress records from one
   * run share this id; older persisted transcripts may omit it.
   */
  attemptId: z.string().min(1).optional().catch(undefined),
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
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('planned'),
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
  WorkflowCallSkippedProgressSchema,
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal('failed'),
    error: z.string().min(1),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

export type WorkflowCallProgress = z.infer<typeof WorkflowCallProgressSchema>;
export type WorkflowCallTerminalProgress = Exclude<
  WorkflowCallProgress,
  { readonly status: 'planned' | 'running' }
>;

/** One lifecycle predicate shared by persistence and transcript projections. */
export function isTerminalWorkflowCallProgress(
  call: WorkflowCallProgress,
): call is WorkflowCallTerminalProgress {
  switch (call.status) {
    case 'planned':
    case 'running':
      return false;
    case 'completed':
    case 'cached':
    case 'skipped':
    case 'failed':
      return true;
  }
}

export const WORKFLOW_TASK_STATUS_LABEL = {
  planned: 'Planned',
  running: 'Running',
  waiting: 'Waiting for follow-up',
  completed: 'Finished',
  cached: 'Saved result',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  failed: 'Failed',
} as const satisfies Record<
  WorkflowCallProgress['status'] | 'waiting' | 'cancelled',
  string
>;
