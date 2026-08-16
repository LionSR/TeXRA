import { z } from 'zod';

export const TokenCountSchema = z.int().nonnegative();

/** Provider identifiers for usage tracking. */
export const UsageProviderSchema = z.enum([
  'anthropic',
  'openai',
  'openai-response',
  'google',
  'deepseek',
  'openrouter',
  'dashscope',
  'xai',
  'moonshot',
  'minimax',
  'glm',
  'meta',
  'unknown',
]);

export const UsageRouteSchema = z.enum([
  'chatgpt-subscription',
  'xai-subscription',
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
  'relay',
  'api-key',
]);

export type UsageRoute = z.infer<typeof UsageRouteSchema>;

export const TokenUsageStatsBaseSchema = z.strictObject({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cost: z.number().nonnegative(),
  cacheReadInputTokens: TokenCountSchema.optional(),
  cacheMissInputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  usageRoute: UsageRouteSchema.optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsBaseSchema>;

export const TokenUsageStatsSchema = TokenUsageStatsBaseSchema;

type EmptyUsageStats = Required<Omit<TokenUsageStats, 'usageRoute'>> &
  Pick<TokenUsageStats, 'usageRoute'>;

/** Returns zero-initialized usage stats. */
export function emptyUsageStats(): EmptyUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
  };
}

/** Whether usage stats are all zeros (effectively empty). */
export function isEmptyUsage(usage: TokenUsageStats): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cost === 0 &&
    (usage.cacheReadInputTokens ?? 0) === 0 &&
    (usage.cacheMissInputTokens ?? 0) === 0 &&
    (usage.cacheCreationInputTokens ?? 0) === 0 &&
    (usage.reasoningTokens ?? 0) === 0
  );
}

/** Accumulates usage stats from an iterable into a single total. */
export function sumUsageStats(
  items: Iterable<TokenUsageStats>,
): TokenUsageStats {
  const total = emptyUsageStats();
  let commonUsageRoute: UsageRoute | undefined;
  let hasMixedOrMissingUsageRoute = false;
  for (const usage of items) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cost += usage.cost;
    total.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    total.cacheMissInputTokens += usage.cacheMissInputTokens ?? 0;
    total.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    total.reasoningTokens += usage.reasoningTokens ?? 0;
    if (!isEmptyUsage(usage)) {
      const usageRoute = usage.usageRoute;
      if (usageRoute == null) {
        hasMixedOrMissingUsageRoute = true;
      } else if (commonUsageRoute == null) {
        commonUsageRoute = usageRoute;
      } else if (commonUsageRoute !== usageRoute) {
        hasMixedOrMissingUsageRoute = true;
      }
    }
  }
  if (commonUsageRoute && !hasMixedOrMissingUsageRoute) {
    total.usageRoute = commonUsageRoute;
  }
  return total;
}

/** Run-keyed usage map: `{ runId: TokenUsageStats }`. Single source of truth used by
 * stream state, snapshot, and IPC message schemas so all four sites stay in sync. */
export const RunUsageMapSchema = z.record(z.string(), TokenUsageStatsSchema);

/**
 * Extended token usage with per-round deltas. Note: percentageCached is
 * calculated from accumulated session totals for overall caching effectiveness.
 */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsBaseSchema.extend({
  elapsedTime: z.number().nonnegative().optional(),
  percentageCached: z.number().nonnegative().optional(),
  toolUseTokens: TokenCountSchema.optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;
