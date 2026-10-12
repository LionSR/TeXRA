import { z } from 'zod';

export const TokenCountSchema = z.int().nonnegative();

export const UsageRouteSchema = z.enum([
  'chatgpt-subscription',
  'xai-subscription',
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
  'api-key',
]);

export type UsageRoute = z.infer<typeof UsageRouteSchema>;

/**
 * The subscription routes a run can decline. A retry the user answered with
 * their own API key declines the route that ran out of quota, for that run
 * only: the choice is a fact of the run, not of the user's settings, so no
 * preference is rewritten and two concurrent runs cannot cancel each other's
 * fallback. `api-key` is excluded because it is the route a decline falls
 * back to.
 */
export const DeclinableUsageRouteSchema = UsageRouteSchema.exclude(['api-key']);

export type DeclinableUsageRoute = z.infer<typeof DeclinableUsageRouteSchema>;

export const TokenUsageStatsSchema = z.strictObject({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cost: z.number().nonnegative(),
  cacheReadInputTokens: TokenCountSchema.optional(),
  cacheMissInputTokens: TokenCountSchema.optional(),
  cacheCreationInputTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  usageRoute: UsageRouteSchema.optional(),
  /** The subscription plan that covered this usage, when the route names one
   *  (today only `chatgpt-subscription`). Recorded per usage row so a resumed
   *  run still reports the plan it actually ran on, not today's. */
  usagePlan: z.string().optional(),
});

export type TokenUsageStats = z.infer<typeof TokenUsageStatsSchema>;

type EmptyUsageStats = Required<
  Omit<TokenUsageStats, 'usageRoute' | 'usagePlan'>
> &
  Pick<TokenUsageStats, 'usageRoute' | 'usagePlan'>;

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

/** Accumulates usage stats from an iterable into a single total. The route
 *  and plan are kept when every nonempty item names the same one. */
export function sumUsageStats(
  items: Iterable<TokenUsageStats>,
): TokenUsageStats {
  const total = emptyUsageStats();
  const routes = new Set<UsageRoute | undefined>();
  const plans = new Set<string | undefined>();
  for (const usage of items) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cost += usage.cost;
    total.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    total.cacheMissInputTokens += usage.cacheMissInputTokens ?? 0;
    total.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    total.reasoningTokens += usage.reasoningTokens ?? 0;
    if (isEmptyUsage(usage)) continue;
    routes.add(usage.usageRoute);
    plans.add(usage.usagePlan);
  }
  const [route] = routes;
  const [plan] = plans;
  if (routes.size === 1 && route) total.usageRoute = route;
  if (plans.size === 1 && plan) total.usagePlan = plan;
  return total;
}

/** Extended token usage with per-round deltas. */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.extend({
  elapsedTime: z.number().nonnegative().optional(),
  toolUseTokens: TokenCountSchema.optional(),
});

export type ExtendedTokenUsageStats = z.infer<
  typeof ExtendedTokenUsageStatsSchema
>;

/**
 * Schema for the totals recorded when a run ends.
 *
 * `totalCost` is the running sum of `NormalizedUsage.cost`, which is already
 * calculated per provider (including prompt-cache discounts or creation
 * premiums). No extra adjustments are applied here.
 */
export const RunUsageTotalsSchema = z.object({
  firstInputTokens: TokenCountSchema.prefault(0),
  totalInputTokens: TokenCountSchema.prefault(0),
  totalOutputTokens: TokenCountSchema.prefault(0),
  totalCost: z.number().nonnegative().prefault(0),
  totalCacheReadInputTokens: TokenCountSchema.prefault(0),
  totalCacheMissInputTokens: TokenCountSchema.prefault(0),
  totalCacheCreationInputTokens: TokenCountSchema.prefault(0),
  totalReasoningTokens: TokenCountSchema.prefault(0),
  totalToolUsePromptTokens: TokenCountSchema.prefault(0),
});

export type RunUsageTotals = z.infer<typeof RunUsageTotalsSchema>;

/** `totals` summed field by field; the first input is the first's. */
export function sumRunUsageTotals(
  totals: readonly RunUsageTotals[],
): RunUsageTotals {
  const sum = RunUsageTotalsSchema.parse({});
  for (const usage of totals)
    for (const key of RunUsageTotalsSchema.keyof().options)
      if (key !== 'firstInputTokens') sum[key] += usage[key];
  sum.firstInputTokens = totals[0]?.firstInputTokens ?? 0;
  return sum;
}

/** A run's usage before its first turn: every counter at its zero. */
export const EMPTY_RUN_USAGE_TOTALS: RunUsageTotals = Object.freeze(
  RunUsageTotalsSchema.parse({}),
);
