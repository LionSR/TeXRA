/**
 * The coding plans TeXRA offers (Kimi Code, the GLM Coding Plan): API-key
 * subscriptions a provider key pays through, with the names, links and
 * labels every host shows for them. Plain data, so browser webviews render
 * the same catalog; the app attaches each plan's preference toggle
 * (`model/codingPlanSubscriptions.ts`). What a used-up plan falls back to is
 * the harness's retry copy (`quotaFallbackRouteFor`), not this catalog's.
 */
import type { DeclinableUsageRoute } from '@shared/schemas';

/** One coding plan's identity and presentation, keyed by its usage route. */
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
  readonly displayName: string;
  readonly preferenceLabel: string;
  readonly modelFamily: string;
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
    displayName: 'Kimi Code',
    preferenceLabel: 'Kimi Code subscription',
    modelFamily: 'Kimi models',
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
    displayName: 'GLM Coding Plan',
    preferenceLabel: 'GLM Coding Plan',
    modelFamily: 'GLM models',
  }),
] as const satisfies readonly CodingPlanSubscriptionDescriptor[]);

/** One coding plan of the catalog. */
export type CodingPlanSubscription = (typeof CODING_PLAN_SUBSCRIPTIONS)[number];
/** The id of a coding plan. */
export type CodingPlanSubscriptionId = CodingPlanSubscription['id'];

const CODING_PLAN_BY_USAGE_ROUTE = new Map<string, CodingPlanSubscription>(
  CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.usageRoute, plan]),
);

/** The coding plan whose credential an API provider owns, by provider. */
export const CODING_PLAN_BY_API_PROVIDER: ReadonlyMap<
  string,
  CodingPlanSubscription
> = new Map(CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.apiProvider, plan]));

/** Resolve a coding plan from the route stamped on completed usage. */
export function codingPlanForUsageRoute(
  route: string | undefined,
): CodingPlanSubscription | undefined {
  return route === undefined
    ? undefined
    : CODING_PLAN_BY_USAGE_ROUTE.get(route);
}
