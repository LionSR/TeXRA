import { z } from 'zod';

import { LineCountSchema } from './lineChanges';

const WorkflowScriptDeliveryFileSchema = z.strictObject({
  path: z.string(),
  added: LineCountSchema.nullable(),
  removed: LineCountSchema.nullable(),
});

/** Compact, host-neutral facts used to present a workflow-script delivery. */
export const WorkflowScriptDeliverySummarySchema = z.strictObject({
  name: z.string(),
  outcome: z.enum(['completed', 'failed']),
  phaseCount: z.int().nonnegative(),
  taskDone: z.int().nonnegative(),
  taskTotal: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.int().nonnegative(),
  files: z.array(WorkflowScriptDeliveryFileSchema),
  scriptPath: z.string(),
  errorCause: z.string().nullable(),
});

export type WorkflowScriptDeliverySummary = z.infer<
  typeof WorkflowScriptDeliverySummarySchema
>;
