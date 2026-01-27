// Third-party imports
import { z } from 'zod';

export const TokenUsageStatsSchema = z.strictObject({
  /** Number of input tokens consumed */
  inputTokens: z.number(),
  /** Number of output tokens generated */
  outputTokens: z.number(),
  /** Total cost in USD for the request */
  cost: z.number(),
  /** Tokens read from cache (discounted rate) */
  cacheReadInputTokens: z.number().optional(),
  /** Tokens written to cache (Anthropic: charged at 1.25x input price) */
  cacheCreationInputTokens: z.number().optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

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

/** Context window utilization state */
export const ContextStateSchema = z.object({
  inputTokens: z.number(),
  contextWindow: z.number(),
  utilizationPercent: z.number(),
});
export type ContextState = z.infer<typeof ContextStateSchema>;
