/**
 * Token usage statistics for tracking model usage and costs.
 */
// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import {
  StorageKeySchema,
  StreamTabIdSchema,
  TokenUsageStatsSchema,
  type TokenUsageStats,
} from '@shared/schemas';

/**
 * Extended statistics tracked during agent execution.
 *
 * IMPORTANT: This type has dual-use semantics:
 * - Token counts (inputTokens, outputTokens, etc.) are per-round deltas
 * - percentageCached is calculated from accumulated session totals
 *
 * This is intentional: percentageCached should reflect overall session caching
 * effectiveness, not per-round fluctuations. Consumers accumulate the per-round
 * deltas while percentageCached provides the running session percentage.
 */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  /** Total elapsed time in seconds */
  elapsedTime: z.number().optional(),
  /** Percentage of tokens served from cache (calculated from session totals) */
  percentageCached: z.number().optional(),
  /** Tokens used for reasoning */
  reasoningTokens: z.number().optional(),
  /** Tokens consumed by tool use */
  toolUseTokens: z.number().optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;

/**
 * Message interface for updating usage stats in the progress view.
 */
export const StreamUsageMessageSchema = z.strictObject({
  command: z.literal('updateUsage'),
  stream: StreamTabIdSchema,
  usageByRun: z.record(StorageKeySchema, TokenUsageStatsSchema).prefault({}),
});

export type StreamUsageMessage = z.infer<typeof StreamUsageMessageSchema>;
