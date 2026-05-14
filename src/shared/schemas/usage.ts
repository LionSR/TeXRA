import { z } from 'zod';

const TokenCountSchema = z.int().nonnegative();

export const TokenUsageStatsSchema = z.strictObject({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cost: z.number().nonnegative(),
  cacheReadInputTokens: TokenCountSchema.optional(),
  cacheMissInputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

/** Returns zero-initialized usage stats. */
export function emptyUsageStats(): TokenUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/** Accumulates usage stats from an iterable into a single total. */
export function sumUsageStats(
  items: Iterable<TokenUsageStats>,
): TokenUsageStats {
  const total = emptyUsageStats();
  for (const usage of items) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cost += usage.cost;
    total.cacheReadInputTokens =
      (total.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
    total.cacheMissInputTokens =
      (total.cacheMissInputTokens ?? 0) + (usage.cacheMissInputTokens ?? 0);
    total.cacheCreationInputTokens =
      (total.cacheCreationInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0);
  }
  return total;
}

/**
 * Extended token usage with per-round deltas. Note: percentageCached is
 * calculated from accumulated session totals for overall caching effectiveness.
 */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  elapsedTime: z.number().nonnegative().optional(),
  percentageCached: z.number().nonnegative().optional(),
  reasoningTokens: TokenCountSchema.optional(),
  toolUseTokens: TokenCountSchema.optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;
