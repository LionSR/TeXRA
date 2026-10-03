import { z } from 'zod';

import { LineCountSchema } from './lineChanges';

/** How a background script's calls ended. */
const ScriptTallySchema = z.strictObject({
  total: z.int().nonnegative(),
  ok: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  /** Skipped by the user. */
  skipped: z.int().nonnegative(),
});
export type ScriptTally = z.infer<typeof ScriptTallySchema>;

const ScriptDeliveryFileSchema = z.strictObject({
  path: z.string(),
  added: LineCountSchema.nullable(),
  removed: LineCountSchema.nullable(),
});

/** Compact, host-neutral facts used to present a background script's
 *  delivery. */
export const ScriptDeliverySummarySchema = z.strictObject({
  name: z.string(),
  outcome: z.enum(['completed', 'failed', 'stopped']),
  phaseCount: z.int().nonnegative(),
  tally: ScriptTallySchema,
  costUsd: z.number().nonnegative(),
  durationMs: z.int().nonnegative(),
  files: z.array(ScriptDeliveryFileSchema),
  errorCause: z.string().nullable(),
});

export type ScriptDeliverySummary = z.infer<typeof ScriptDeliverySummarySchema>;
