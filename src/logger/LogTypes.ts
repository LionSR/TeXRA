/**
 * Shared logging interfaces used by the logger and progress view.
 * Defines Zod schemas as single source of truth, derives TypeScript types.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import { LogMessageDataSchema, TaskGroupSchema } from '@shared/schemas';

export type { LogMessageData, TaskGroup } from '@shared/schemas';

/**
 * Log message update schema - partial update for existing log entries.
 * All fields optional except id (required for identifying the entry to update).
 */
export const LogMessageUpdateSchema = LogMessageDataSchema.partial().required({
  id: true,
});

export type LogMessageUpdate = z.infer<typeof LogMessageUpdateSchema>;
