// Third-party imports
/**
 * Diff statistic schema used for file comparisons.
 */
import { z } from 'zod';

export const DiffStatsSchema = z.object({
  /** Number of added lines */
  added: z.number().optional(),
  /** Number of removed lines */
  removed: z.number().optional(),
});

export type DiffStats = z.infer<typeof DiffStatsSchema>;
