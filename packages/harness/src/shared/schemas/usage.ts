import { Effect, Schema, Struct, type Types } from 'effect';

import { StoredProtocolSchema } from './storedTurn';

export const TokenCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

export const UsageRouteSchema = Schema.Literals([
  'chatgpt-subscription',
  'xai-subscription',
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
  'api-key',
]);

/** The route a request's usage is billed through. */
export type UsageRoute = typeof UsageRouteSchema.Type;

/**
 * The subscription routes a run can decline. A retry the user answered with
 * their own API key declines the route that ran out of quota, for that run
 * only: the choice is a fact of the run, not of the user's settings, so no
 * preference is rewritten and two concurrent runs cannot cancel each other's
 * fallback. `api-key` is excluded because it is the route a decline falls
 * back to.
 */
export const DeclinableUsageRouteSchema = UsageRouteSchema.pick([
  'chatgpt-subscription',
  'xai-subscription',
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
]);

export type DeclinableUsageRoute = typeof DeclinableUsageRouteSchema.Type;

export const TokenUsageStatsSchema = Schema.Struct({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheReadInputTokens: Schema.optional(TokenCountSchema),
  cacheMissInputTokens: Schema.optional(TokenCountSchema),
  cacheCreationInputTokens: Schema.optional(TokenCountSchema),
  reasoningTokens: Schema.optional(TokenCountSchema),
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
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
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

/** Extended token usage with per-round deltas. */
export const ExtendedTokenUsageStatsSchema = TokenUsageStatsSchema.mapFields(
  Struct.assign({
    elapsedTime: Schema.optional(
      Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
    toolUseTokens: Schema.optional(TokenCountSchema),
  }),
);

export type ExtendedTokenUsageStats =
  (typeof ExtendedTokenUsageStatsSchema)['Type'];

/**
 * Schema for the totals recorded when a run ends.
 *
 * `totalCost` is the running sum of `NormalizedUsage.cost`, which is already
 * calculated per provider (including prompt-cache discounts or creation
 * premiums). No extra adjustments are applied here.
 */
export const RunUsageTotalsSchema = Schema.Struct({
  firstInputTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalInputTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalOutputTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalCost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalCacheReadInputTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalCacheMissInputTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalCacheCreationInputTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalReasoningTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  totalToolUsePromptTokens: TokenCountSchema.pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
});

export type RunUsageTotals = typeof RunUsageTotalsSchema.Type;

/** A run's usage before its first turn: every counter at its zero. */
export const EMPTY_RUN_USAGE_TOTALS: RunUsageTotals = Object.freeze(
  Schema.decodeUnknownSync(RunUsageTotalsSchema)({}),
);

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
 * Normalized usage statistics from any model provider: the ONLY usage type
 * after API response extraction. The package's `TurnResult.usage` is priced
 * into this shape by `run/pricing.ts`.
 *
 * Reuses only the required base fields via `.pick()` — the optional cache
 * fields on `TokenUsageStatsSchema` (`cacheReadInputTokens` /
 * `cacheCreationInputTokens`) are never populated for a NormalizedUsage; the
 * live cache metrics below (`cachedInputTokens` / `cacheCreationTokens`) are
 * the authoritative names. Extending the full base instead would inherit
 * those dead fields and duplicate `cacheMissInputTokens`.
 */
export const NormalizedUsageSchema = TokenUsageStatsSchema.mapFields(
  Struct.pick(['inputTokens', 'outputTokens', 'cost']),
).mapFields(
  Struct.assign({
    /** Response time in milliseconds */
    responseTimeMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Wire surface that produced this usage; usage is billed per surface. */
    provider: StoredProtocolSchema,

    // Optional metrics (when supported by provider)
    /** Tokens served from cache (reduces cost) */
    cachedInputTokens: Schema.optional(TokenCountSchema),
    /** Tokens that missed provider prompt cache and were billed at full input rate */
    cacheMissInputTokens: Schema.optional(TokenCountSchema),
    /** Tokens written to cache - Anthropic only (increases cost by 1.25x) */
    cacheCreationTokens: Schema.optional(TokenCountSchema),
    /** Tokens used for reasoning (OpenAI reasoning models, Claude and Gemini thinking) */
    reasoningTokens: Schema.optional(TokenCountSchema),
    /** Tokens consumed by tool use prompts (Google) */
    toolUsePromptTokens: Schema.optional(TokenCountSchema),
    /** Canonical route used for usage display and telemetry. */
    usageRoute: Schema.optional(UsageRouteSchema),
    /** The route's subscription plan, when it names one; display-only. */
    usagePlan: Schema.optional(Schema.String),
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
    totalCacheReadInputTokens:
      totals.totalCacheReadInputTokens + (usage.cachedInputTokens ?? 0),
    totalCacheMissInputTokens:
      totals.totalCacheMissInputTokens + (usage.cacheMissInputTokens ?? 0),
    totalCacheCreationInputTokens:
      totals.totalCacheCreationInputTokens + (usage.cacheCreationTokens ?? 0),
    totalReasoningTokens:
      totals.totalReasoningTokens + (usage.reasoningTokens ?? 0),
    totalToolUsePromptTokens:
      totals.totalToolUsePromptTokens + (usage.toolUsePromptTokens ?? 0),
  };
}
