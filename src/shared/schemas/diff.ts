// Third-party imports
import { z } from 'zod';

/**
 * Schema for line change statistics.
 * Single source of truth - used by ToolResult, edits, and model handlers.
 */
export const LineChangesSchema = z.object({
  added: z.number(),
  removed: z.number(),
});
export type LineChanges = z.infer<typeof LineChangesSchema>;
