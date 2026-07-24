import { z } from 'zod';

export const WorkflowTaskIdentitySchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .describe('Stable task identity referenced by workflow agent calls.'),
  label: z
    .string()
    .trim()
    .min(1)
    .describe('Human-readable task name shown on progress surfaces.'),
  phase: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional declared workflow phase containing the task.'),
});
export type WorkflowTaskIdentity = z.infer<typeof WorkflowTaskIdentitySchema>;

const WorkflowTaskTerminalMetadataSchema = z.strictObject({
  model: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
});

/**
 * Canonical state of one declared or dynamically issued workflow-script task.
 * The status discriminant prevents terminal-only metadata from appearing on a
 * task that has not started.
 */
export const WorkflowTaskProgressSchema = z.discriminatedUnion('status', [
  WorkflowTaskIdentitySchema.extend({
    status: z.literal('planned'),
  }),
  WorkflowTaskIdentitySchema.extend({
    status: z.literal('running'),
  }),
  WorkflowTaskIdentitySchema.extend({
    status: z.literal('completed'),
    ...WorkflowTaskTerminalMetadataSchema.shape,
  }),
  WorkflowTaskIdentitySchema.extend({
    status: z.literal('cached'),
  }),
  WorkflowTaskIdentitySchema.extend({
    status: z.literal('skipped'),
    reason: z.enum(['not-reached', 'user']),
  }),
  WorkflowTaskIdentitySchema.extend({
    status: z.literal('failed'),
    error: z.string().min(1),
    ...WorkflowTaskTerminalMetadataSchema.shape,
  }),
]);

export type WorkflowTaskProgress = z.infer<typeof WorkflowTaskProgressSchema>;

export const WORKFLOW_TASK_STATUS_LABEL = {
  planned: 'Planned',
  running: 'Running',
  completed: 'Finished',
  cached: 'Saved result',
  skipped: 'Skipped',
  failed: 'Failed',
} as const satisfies Record<WorkflowTaskProgress['status'], string>;
