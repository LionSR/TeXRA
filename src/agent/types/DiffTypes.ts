/**
 * Diff statistic schema used for file comparisons.
 * Derives from LineChangesSchema (single source of truth) with optional fields.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - tools (single source of truth)
import { LineChangesSchema } from '@tools/result';

/**
 * Schema for diff statistics - partial version of LineChanges.
 * Used when computing diffs where fields may be absent (e.g., new file has only 'added').
 */
export const DiffStatsSchema = LineChangesSchema.partial();

export type DiffStats = z.infer<typeof DiffStatsSchema>;

// Re-export LineChanges for consumers that need the required version
export { LineChangesSchema, type LineChanges } from '@tools/result';
