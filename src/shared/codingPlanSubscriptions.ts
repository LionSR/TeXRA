import { GlobalStateKey } from './state/stateKeys';
import type { ExhaustionReason } from './schemas/errors';
import type { UsageRoute } from './schemas/usage';

/**
 * Static identity and presentation data for one API-key-authenticated coding
 * plan. Runtime preference and routing behaviour is attached in
 * `@model/codingPlanSubscriptions`; keeping this part dependency-free lets all
 * hosts, including browser webviews, render the same provider catalog.
 */
interface CodingPlanSubscriptionDescriptor {
  readonly id: 'glmCodingPlan' | 'kimiCode';
  readonly cliProvider: 'glm-code' | 'kimi-code';
  readonly cliAliases: readonly string[];
  readonly apiProvider: 'glm' | 'kimiCode';
  readonly credentialName: string;
  readonly credentialSetupUrl: string;
  readonly usageProvider: 'glmCodingPlan' | 'kimiCode';
  readonly usageRoute:
    'glm-coding-plan-subscription' | 'kimi-code-subscription';
  readonly exhaustionReason: Extract<
    ExhaustionReason,
    'glm-coding-plan' | 'kimi-code-subscription'
  >;
  readonly displayName: string;
  readonly preferenceLabel: string;
  readonly modelFamily: string;
  readonly retryFallbackName: string;
  readonly retrySourceName: string;
  readonly usageVariantSettingKeys: readonly string[];
  readonly sectionId: string;
  readonly description: string;
  readonly consoleUrl: string;
  readonly keyLabel: string;
  readonly keyHelp: string;
  readonly toggleLabel: string;
  readonly toggleHelp: string;
}

/** Canonical catalog of coding-plan providers supported by every host. */
export const CODING_PLAN_SUBSCRIPTIONS = Object.freeze([
  Object.freeze({
    id: 'kimiCode',
    cliProvider: 'kimi-code',
    cliAliases: ['kimi', 'kimicode', 'kimi-code'],
    apiProvider: 'kimiCode',
    credentialName: 'Kimi Code',
    credentialSetupUrl: 'https://www.kimi.com/code/console',
    usageProvider: 'kimiCode',
    usageRoute: 'kimi-code-subscription',
    exhaustionReason: 'kimi-code-subscription',
    displayName: 'Kimi Code',
    preferenceLabel: 'Prefer Kimi Code subscription',
    modelFamily: 'Kimi models',
    retryFallbackName: 'your own Moonshot API keys',
    retrySourceName: 'Kimi Code subscription',
    usageVariantSettingKeys: [],
    sectionId: 'kimi-code-subscription',
    description: 'Use a Kimi Code membership for the kimi-for-coding models.',
    consoleUrl: 'https://www.kimi.com/code/console',
    keyLabel: '1. Get a membership key',
    keyHelp: 'Create an API key in the Kimi Code console.',
    toggleLabel: '3. Optional: prefer Kimi Code',
    toggleHelp:
      'Enable "Prefer Kimi Code" on the same row so K3 also uses your Kimi Code subscription; the kimi-for-coding models always do.',
  }),
  Object.freeze({
    id: 'glmCodingPlan',
    cliProvider: 'glm-code',
    cliAliases: ['glm', 'glmcode', 'glm-code', 'glm-coding', 'glm-coding-plan'],
    apiProvider: 'glm',
    credentialName: 'GLM',
    credentialSetupUrl: 'https://open.bigmodel.cn or https://z.ai',
    usageProvider: 'glmCodingPlan',
    usageRoute: 'glm-coding-plan-subscription',
    exhaustionReason: 'glm-coding-plan',
    displayName: 'GLM Coding Plan',
    preferenceLabel: 'Prefer GLM Coding Plan',
    modelFamily: 'GLM models',
    retryFallbackName: 'the regular GLM endpoint',
    retrySourceName: 'GLM Coding Plan',
    usageVariantSettingKeys: [GlobalStateKey.GLM_USE_CHINA],
    sectionId: 'glm-coding-plan-subscription',
    description:
      'Use a GLM Coding Plan subscription for GLM models via the coding endpoint.',
    consoleUrl: 'https://z.ai/subscribe',
    keyLabel: '1. Get a subscription key',
    keyHelp: 'Subscribe and create an API key in the Z.AI console.',
    toggleLabel: '3. Enable the Coding Plan',
    toggleHelp:
      'Turn on "GLM Coding Plan" on the GLM row so requests route through the coding endpoint with your plan\u2019s monthly quota.',
  }),
] as const satisfies readonly CodingPlanSubscriptionDescriptor[]);

export type CodingPlanSubscription = (typeof CODING_PLAN_SUBSCRIPTIONS)[number];
export type CodingPlanSubscriptionId = CodingPlanSubscription['id'];

const CODING_PLAN_BY_USAGE_ROUTE = new Map<UsageRoute, CodingPlanSubscription>(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.usageRoute, plan]),
);

const CODING_PLAN_BY_EXHAUSTION_REASON = new Map<
  ExhaustionReason,
  CodingPlanSubscription
>(CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.exhaustionReason, plan]));

const CODING_PLAN_BY_API_PROVIDER = new Map<string, CodingPlanSubscription>(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.apiProvider, plan]),
);

const CODING_PLAN_BY_ID = new Map<
  CodingPlanSubscriptionId,
  CodingPlanSubscription
>(CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.id, plan]));

const CODING_PLAN_BY_USAGE_SETTING = new Map<string, CodingPlanSubscription>(
  CODING_PLAN_SUBSCRIPTIONS.flatMap((plan) =>
    plan.usageVariantSettingKeys.map((key) => [key, plan] as const),
  ),
);

/** Resolve a coding plan from the route stamped on completed usage. */
export function codingPlanForUsageRoute(
  route: UsageRoute | undefined,
): CodingPlanSubscription | undefined {
  return route === undefined
    ? undefined
    : CODING_PLAN_BY_USAGE_ROUTE.get(route);
}

/** Resolve a coding plan from a provider quota failure. */
export function codingPlanForExhaustionReason(
  reason: ExhaustionReason | undefined,
): CodingPlanSubscription | undefined {
  return reason === undefined
    ? undefined
    : CODING_PLAN_BY_EXHAUSTION_REASON.get(reason);
}

/** Resolve a coding plan whose credential is owned by an API provider. */
export function codingPlanForApiProvider(
  provider: string,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_BY_API_PROVIDER.get(provider);
}

/** Resolve a plan whose usage endpoint varies with a setting. */
export function codingPlanForUsageSetting(
  key: string,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_BY_USAGE_SETTING.get(key);
}

/** Resolve a coding plan by its stable cross-host identifier. */
export function codingPlanForId(
  id: CodingPlanSubscriptionId,
): CodingPlanSubscription {
  const plan = CODING_PLAN_BY_ID.get(id);
  if (!plan) throw new Error(`Unknown coding-plan subscription: ${id}`);
  return plan;
}
