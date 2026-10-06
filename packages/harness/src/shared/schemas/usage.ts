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

/**
 * Static identity and presentation data for one API-key-authenticated coding
 * plan, keyed by the usage route its calls are stamped with. The app attaches
 * its preference toggles and the settings its usage endpoint varies with;
 * keeping this part dependency-free lets all hosts, including browser
 * webviews, render the same provider catalog.
 */
interface CodingPlanSubscriptionDescriptor {
  readonly id: 'glmCodingPlan' | 'kimiCode';
  readonly cliProvider: 'glm-code' | 'kimi-code';
  readonly apiProvider: 'glm' | 'kimiCode';
  readonly exclusiveCredential: boolean;
  readonly credentialName: string;
  readonly credentialSetupUrl: string;
  readonly usageProvider: 'glmCodingPlan' | 'kimiCode';
  readonly usageRoute: Extract<
    DeclinableUsageRoute,
    'glm-coding-plan-subscription' | 'kimi-code-subscription'
  >;
  readonly exhaustionReason: 'glm-coding-plan' | 'kimi-code-subscription';
  readonly displayName: string;
  readonly preferenceLabel: string;
  readonly modelFamily: string;
  readonly retryFallbackName: string;
  readonly retrySourceName: string;
}

/** Canonical catalog of coding-plan providers supported by every host. */
export const CODING_PLAN_SUBSCRIPTIONS = Object.freeze([
  Object.freeze({
    id: 'kimiCode',
    cliProvider: 'kimi-code',
    apiProvider: 'kimiCode',
    exclusiveCredential: true,
    credentialName: 'Kimi Code',
    credentialSetupUrl: 'https://www.kimi.com/code/console',
    usageProvider: 'kimiCode',
    usageRoute: 'kimi-code-subscription',
    exhaustionReason: 'kimi-code-subscription',
    displayName: 'Kimi Code',
    preferenceLabel: 'Kimi Code subscription',
    modelFamily: 'Kimi models',
    retryFallbackName: 'your own Moonshot API keys',
    retrySourceName: 'Kimi Code subscription',
  }),
  Object.freeze({
    id: 'glmCodingPlan',
    cliProvider: 'glm-code',
    apiProvider: 'glm',
    exclusiveCredential: false,
    credentialName: 'GLM',
    credentialSetupUrl: 'https://open.bigmodel.cn or https://z.ai',
    usageProvider: 'glmCodingPlan',
    usageRoute: 'glm-coding-plan-subscription',
    exhaustionReason: 'glm-coding-plan',
    displayName: 'GLM Coding Plan',
    preferenceLabel: 'GLM Coding Plan',
    modelFamily: 'GLM models',
    retryFallbackName: 'the regular GLM endpoint',
    retrySourceName: 'GLM Coding Plan',
  }),
] as const satisfies readonly CodingPlanSubscriptionDescriptor[]);

/** One coding plan of the catalog. */
export type CodingPlanSubscription = (typeof CODING_PLAN_SUBSCRIPTIONS)[number];
/** The id of a coding plan. */
export type CodingPlanSubscriptionId = CodingPlanSubscription['id'];

const CODING_PLAN_BY_USAGE_ROUTE = new Map<string, CodingPlanSubscription>(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.usageRoute, plan]),
);

const CODING_PLAN_BY_API_PROVIDER = new Map<string, CodingPlanSubscription>(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.apiProvider, plan]),
);

/** Resolve a coding plan from the route stamped on completed usage. */
export function codingPlanForUsageRoute(
  route: string | undefined,
): CodingPlanSubscription | undefined {
  return route === undefined
    ? undefined
    : CODING_PLAN_BY_USAGE_ROUTE.get(route);
}

/** Resolve a coding plan whose credential is owned by an API provider. */
export function codingPlanForApiProvider(
  provider: string,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_BY_API_PROVIDER.get(provider);
}

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
