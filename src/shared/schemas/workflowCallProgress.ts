import { z } from 'zod';

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

const WorkflowCallTerminalMetadataSchema = z.strictObject({
  model: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
});

/**
 * Canonical state of one declared or dynamically issued workflow-script call.
 * The status discriminant prevents terminal-only metadata from appearing on a
 * call that has not started.
 */
const WorkflowCallSkippedProgressSchema = z.discriminatedUnion('reason', [
  WorkflowCallIdentitySchema.extend({
    status: z.literal('skipped'),
    reason: z.literal('not-reached'),
  }),
  WorkflowCallIdentitySchema.extend({
    status: z.literal('skipped'),
    reason: z.literal('user'),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

export const WorkflowCallProgressSchema = z.discriminatedUnion('status', [
  WorkflowCallIdentitySchema.extend({
    status: z.literal('planned'),
  }),
  WorkflowCallIdentitySchema.extend({
    status: z.literal('running'),
  }),
  WorkflowCallIdentitySchema.extend({
    status: z.literal('completed'),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallIdentitySchema.extend({
    status: z.literal('cached'),
  }),
  WorkflowCallSkippedProgressSchema,
  WorkflowCallIdentitySchema.extend({
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
