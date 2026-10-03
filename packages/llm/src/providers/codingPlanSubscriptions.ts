/**
 * Static identity and presentation data for one API-key-authenticated coding
 * plan. The host attaches its preference toggles and the settings its usage
 * endpoint varies with; keeping this part dependency-free lets all hosts,
 * including browser webviews, render the same provider catalog.
 */
interface CodingPlanSubscriptionDescriptor {
  readonly id: 'glmCodingPlan' | 'kimiCode';
  readonly cliProvider: 'glm-code' | 'kimi-code';
  readonly apiProvider: 'glm' | 'kimiCode';
  readonly exclusiveCredential: boolean;
  readonly credentialName: string;
  readonly credentialSetupUrl: string;
  readonly usageProvider: 'glmCodingPlan' | 'kimiCode';
  readonly usageRoute:
    'glm-coding-plan-subscription' | 'kimi-code-subscription';
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

export type CodingPlanSubscription = (typeof CODING_PLAN_SUBSCRIPTIONS)[number];
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
