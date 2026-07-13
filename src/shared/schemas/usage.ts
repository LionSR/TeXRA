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
  usageRoute: UsageRouteSchema.optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsBaseSchema>;

const TokenUsageStatsInputSchema = TokenUsageStatsBaseSchema.extend({
  viaChatGptSubscription: z.boolean().optional(),
});

export const TokenUsageStatsSchema = TokenUsageStatsInputSchema.transform(
  ({ viaChatGptSubscription, ...usage }): TokenUsageStats => {
    const usageRoute =
      usage.usageRoute ??
      (viaChatGptSubscription === true ? 'chatgpt-subscription' : undefined);
    return usageRoute == null ? usage : { ...usage, usageRoute };
  },
);

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
  };
}

function hasUsageActivity(usage: TokenUsageStats): boolean {
  return (
    usage.inputTokens !== 0 ||
    usage.outputTokens !== 0 ||
    usage.cost !== 0 ||
    (usage.cacheReadInputTokens ?? 0) !== 0 ||
    (usage.cacheMissInputTokens ?? 0) !== 0 ||
    (usage.cacheCreationInputTokens ?? 0) !== 0
  );
}

/** Whether usage stats are all zeros (effectively empty). */
export function isEmptyUsage(usage: TokenUsageStats): boolean {
  return !hasUsageActivity(usage);
}

/** Accumulates usage stats from an iterable into a single total. */
export function sumUsageStats(
  items: Iterable<TokenUsageStats>,
): TokenUsageStats {
  const total = emptyUsageStats();
  let sawUsageActivity = false;
  let commonUsageRoute: UsageRoute | undefined;
  let sawUsageRoute = false;
  let hasMixedOrMissingUsageRoute = false;
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
    if (hasUsageActivity(usage)) {
      sawUsageActivity = true;

      const usageRoute = usage.usageRoute;
      if (usageRoute == null) {
        hasMixedOrMissingUsageRoute = true;
      } else if (!sawUsageRoute) {
        commonUsageRoute = usageRoute;
        sawUsageRoute = true;
      } else if (commonUsageRoute !== usageRoute) {
        hasMixedOrMissingUsageRoute = true;
        commonUsageRoute = undefined;
      }
    }
  }
  if (
    sawUsageActivity &&
    sawUsageRoute &&
    !hasMixedOrMissingUsageRoute &&
    commonUsageRoute
  ) {
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
  reasoningTokens: TokenCountSchema.optional(),
  toolUseTokens: TokenCountSchema.optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;
