import { z } from 'zod';

/**
 * Nonnegative line-count schema shared by tool results, approvals, and output
 * diff statistics.
 */
export const LineCountSchema = z.int().nonnegative();

/**
 * Schema for line change statistics.
 */
export const LineChangesSchema = z.object({
  added: LineCountSchema,
  removed: LineCountSchema,
});
export type LineChanges = z.infer<typeof LineChangesSchema>;

/**
 * Schema for diff statistics where one side may be absent.
 */
export const DiffStatsSchema = LineChangesSchema.partial();
export type DiffStats = z.infer<typeof DiffStatsSchema>;
