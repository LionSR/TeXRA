import { z } from 'zod';

export const TokenUsageStatsSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

/**
 * Extended token usage with per-round deltas. Note: percentageCached is
 * calculated from accumulated session totals for overall caching effectiveness.
 */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  elapsedTime: z.number().optional(),
  percentageCached: z.number().optional(),
  reasoningTokens: z.number().optional(),
  toolUseTokens: z.number().optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;

export const ContextStateSchema = z.object({
  inputTokens: z.number(),
  contextWindow: z.number(),
  utilizationPercent: z.number(),
});

export type ContextState = z.infer<typeof ContextStateSchema>;
