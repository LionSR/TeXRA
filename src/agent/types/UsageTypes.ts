/**
 * Token usage statistics for tracking model usage and costs.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas (single source of truth)
import {
  StreamTabIdSchema,
  StorageKeySchema,
  TokenUsageStatsSchema,
} from '@shared/schemas';

// Re-export from shared schemas for backwards compatibility
export {
  ExtendedTokenUsageStatsSchema,
  type ExtendedTokenUsageStats,
} from '@shared/schemas';

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.strictObject({
  command: z.literal('updateUsage'),
  stream: StreamTabIdSchema,
  usageByRun: z.record(StorageKeySchema, TokenUsageStatsSchema).prefault({}),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
