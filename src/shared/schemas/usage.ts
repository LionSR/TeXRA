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

/**
 * Migrate the retired `viaChatGptSubscription` boolean into the canonical
 * `usageRoute` field. Single source of the mapping for every usage schema
 * that still accepts the legacy flag on parse (`TokenUsageStatsSchema` here,
 * `TokenUsageStatsParsingBaseSchema` in `streamData.ts`) — persisted usage
 * rows written before `usageRoute` existed are reparsed on every load, so
 * the copies must not drift.
 */
function resolveLegacyUsageRoute<T extends { usageRoute?: UsageRoute }>(
  usage: T,
  viaChatGptSubscription: boolean | undefined,
): T {
  const usageRoute =
    usage.usageRoute ??
    (viaChatGptSubscription === true ? 'chatgpt-subscription' : undefined);
  return usageRoute == null ? usage : { ...usage, usageRoute };
}

/**
 * Appends the retired `viaChatGptSubscription` field to an object schema whose
 * output already carries `usageRoute`, then applies the shared legacy-route
 * migration transform. Single home for the migration envelope: every usage
 * schema that still accepts the legacy flag on parse (`TokenUsageStatsSchema`
 * here, `TokenUsageStatsParsingBaseSchema` in `streamData.ts`,
 * `NormalizedUsageSchema` in `@agent/types/NormalizedUsage`) wraps its own base
 * with this, so the field spelling and the transform can't drift — persisted
 * usage rows written before `usageRoute` existed are reparsed on every load,
 * so a silent divergence would corrupt cost data (see #7464).
 */
export function withLegacyUsageRoute<S extends { usageRoute?: UsageRoute }>(
  base: z.ZodType<S>,
): z.ZodType<S> {
  return (base as z.ZodObject<z.ZodRawShape>)
    .extend({ viaChatGptSubscription: z.boolean().optional() })
    .transform(({ viaChatGptSubscription, ...usage }) =>
      // The `ZodObject<ZodRawShape>` cast widens the added field's output type
      // to `unknown`; the schema itself guarantees `boolean | undefined`.
      resolveLegacyUsageRoute(
        usage as S,
        viaChatGptSubscription as boolean | undefined,
      ),
    );
}

export const TokenUsageStatsSchema = withLegacyUsageRoute<TokenUsageStats>(
  TokenUsageStatsBaseSchema,
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
