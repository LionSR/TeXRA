import { Schema, Struct, type Types } from 'effect';

import { StoredProtocolSchema } from './storedTurn';

export const TokenCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * The subscription routes a run can decline: storage's spelling of llm's
 * `PLAN_ROUTES`, which the route decision converts both ways, so a plan in
 * one list only fails to compile. A retry the user answered with their own
 * API key declines the route that ran out of quota, for that run only: the
 * choice is a fact of the run, not of the user's settings, so no preference
 * is rewritten and two concurrent runs cannot cancel each other's fallback.
 */
export const DeclinableUsageRouteSchema = Schema.Literals([
  'chatgpt-subscription',
  'xai-subscription',
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
]);

export type DeclinableUsageRoute = typeof DeclinableUsageRouteSchema.Type;

export const UsageRouteSchema = Schema.Literals([
  ...DeclinableUsageRouteSchema.literals,
  'api-key',
]);

/** The route a request's usage is billed through. */
export type UsageRoute = typeof UsageRouteSchema.Type;

/**
 * Priced token counts under the names of the package's `TurnUsage`, from
 * one call or summed over many. A count the provider did not report is
 * absent.
 */
export const TokenUsageStatsSchema = Schema.Struct({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Prompt tokens read from the provider's cache. */
  cachedInputTokens: Schema.optional(TokenCountSchema),
  /** Prompt tokens billed at the full input rate: input minus cache reads. */
  cacheMissInputTokens: Schema.optional(TokenCountSchema),
  /** Prompt tokens written to the provider's cache (Anthropic). */
  cacheWriteTokens: Schema.optional(TokenCountSchema),
  reasoningTokens: Schema.optional(TokenCountSchema),
  /** Prompt tokens a provider-run tool added (Google). */
  toolUsePromptTokens: Schema.optional(TokenCountSchema),
  usageRoute: Schema.optional(UsageRouteSchema),
  /** The subscription plan that covered this usage, when the route names one
   *  (today only `chatgpt-subscription`). Recorded per usage row so a resumed
   *  run still reports the plan it actually ran on, not today's. */
  usagePlan: Schema.optional(Schema.String),
});

export type TokenUsageStats = typeof TokenUsageStatsSchema.Type;

/** A usage total under construction: every counter present and writable. */
type EmptyUsageStats = Types.Mutable<
  Required<Omit<TokenUsageStats, 'usageRoute' | 'usagePlan'>> &
    Pick<TokenUsageStats, 'usageRoute' | 'usagePlan'>
>;

/** Returns zero-initialized usage stats. */
export function emptyUsageStats(): EmptyUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    toolUsePromptTokens: 0,
  };
}

/** The numeric counters of a usage row; the route and plan are not counted. */
type UsageCounterKey = Exclude<
  keyof TokenUsageStats,
  'usageRoute' | 'usagePlan'
>;
const USAGE_COUNTER_KEYS = Struct.keys(TokenUsageStatsSchema.fields).filter(
  (key): key is UsageCounterKey => key !== 'usageRoute' && key !== 'usagePlan',
);

/** Whether usage stats are all zeros (effectively empty). */
export function isEmptyUsage(usage: TokenUsageStats): boolean {
  return USAGE_COUNTER_KEYS.every((key) => (usage[key] ?? 0) === 0);
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
    for (const key of USAGE_COUNTER_KEYS) total[key] += usage[key] ?? 0;
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

/**
 * Schema for the totals recorded when a run ends.
 *
 * `totalCost` is the running sum of `NormalizedUsage.cost`, which is already
 * calculated per provider (including prompt-cache discounts or creation
 * premiums). No extra adjustments are applied here.
 */
export const RunUsageTotalsSchema = Schema.Struct({
  firstInputTokens: TokenCountSchema,
  totalInputTokens: TokenCountSchema,
  totalOutputTokens: TokenCountSchema,
  totalCost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  totalCachedInputTokens: TokenCountSchema,
  totalCacheMissInputTokens: TokenCountSchema,
  totalCacheWriteTokens: TokenCountSchema,
  totalReasoningTokens: TokenCountSchema,
  totalToolUsePromptTokens: TokenCountSchema,
});

export type RunUsageTotals = typeof RunUsageTotalsSchema.Type;

/** A run's usage before its first turn: every counter at its zero. */
export const EMPTY_RUN_USAGE_TOTALS: RunUsageTotals = Object.freeze({
  firstInputTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalCachedInputTokens: 0,
  totalCacheMissInputTokens: 0,
  totalCacheWriteTokens: 0,
  totalReasoningTokens: 0,
  totalToolUsePromptTokens: 0,
});

/** `totals` summed field by field; the first input is the first's. */
export function sumRunUsageTotals(
  totals: readonly RunUsageTotals[],
): RunUsageTotals {
  const sum: Types.Mutable<RunUsageTotals> = { ...EMPTY_RUN_USAGE_TOTALS };
  for (const usage of totals)
    for (const key of Struct.keys(RunUsageTotalsSchema.fields))
      if (key !== 'firstInputTokens') sum[key] += usage[key];
  sum.firstInputTokens = totals[0]?.firstInputTokens ?? 0;
  return sum;
}

/**
 * The priced usage of one model call: the counts under `TurnUsage`'s names,
 * its cost, route and plan ({@link TokenUsageStatsSchema}), and the wire
 * surface and response time of the call. `run/pricing.ts` prices the
 * package's `TurnResult.usage` into this shape.
 */
export const NormalizedUsageSchema = TokenUsageStatsSchema.mapFields(
  Struct.assign({
    /** Response time in milliseconds */
    responseTimeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Wire surface that produced this usage; usage is billed per surface. */
    provider: StoredProtocolSchema,
  }),
);
/** Normalized, priced usage of one call ({@link NormalizedUsageSchema}). */
export type NormalizedUsage = typeof NormalizedUsageSchema.Type;

/**
 * The priced usage the writer stamped on one completed turn, summed into the
 * run totals. The package's `turn.usage` is deliberately not the input: it
 * carries token counts and provider-specific extras but no runtime price, so
 * folding it would leave a resumed run's `totalCost` at zero. Every field of the totals is named here, so a new
 * metric on either schema is a compile error rather than a silent zero.
 */
export function addTurnUsage(
  totals: RunUsageTotals,
  usage: NormalizedUsage | null,
): RunUsageTotals {
  if (usage === null) return totals;
  return {
    firstInputTokens:
      totals.firstInputTokens === 0
        ? usage.inputTokens
        : totals.firstInputTokens,
    totalInputTokens: totals.totalInputTokens + usage.inputTokens,
    totalOutputTokens: totals.totalOutputTokens + usage.outputTokens,
    totalCost: totals.totalCost + usage.cost,
    totalCachedInputTokens:
      totals.totalCachedInputTokens + (usage.cachedInputTokens ?? 0),
    totalCacheMissInputTokens:
      totals.totalCacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
    totalCacheWriteTokens:
      totals.totalCacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    totalReasoningTokens:
      totals.totalReasoningTokens + (usage.reasoningTokens ?? 0),
    totalToolUsePromptTokens:
      totals.totalToolUsePromptTokens + (usage.toolUsePromptTokens ?? 0),
  };
}
