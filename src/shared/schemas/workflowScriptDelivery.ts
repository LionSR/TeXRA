import { z } from 'zod';

import { LineCountSchema } from './lineChanges';
import { WorkflowTallySchema } from './workflowCallProgress';

const WorkflowScriptDeliveryFileSchema = z.strictObject({
  path: z.string(),
  added: LineCountSchema.nullable(),
  removed: LineCountSchema.nullable(),
});

/** Compact, host-neutral facts used to present a script's delivery: a
 *  workflow script's, or a background `script` call's. */
export const WorkflowScriptDeliverySummarySchema = z.strictObject({
  name: z.string(),
  outcome: z.enum(['completed', 'failed', 'stopped']),
  phaseCount: z.int().nonnegative(),
  tally: WorkflowTallySchema,
  costUsd: z.number().nonnegative(),
  durationMs: z.int().nonnegative(),
  files: z.array(WorkflowScriptDeliveryFileSchema),
  /** A workflow script's file; a `script` call has none. */
  scriptPath: z.string().nullable(),
  errorCause: z.string().nullable(),
});

export type WorkflowScriptDeliverySummary = z.infer<
  typeof WorkflowScriptDeliverySummarySchema
>;
