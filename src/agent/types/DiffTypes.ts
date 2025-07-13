// Third-party imports
import { z } from 'zod';

/**
 * Zod schema for diff statistics used in file comparisons.
 */
export const DiffStatsSchema = z
  .object({
    /** Number of added lines */
    added: z.number().optional(),
    /** Number of removed lines */
    removed: z.number().optional(),
  })
  .strict();

export type DiffStats = z.infer<typeof DiffStatsSchema>;
