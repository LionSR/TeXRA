/**
 * The coding plans TeXRA offers (Kimi Code, the GLM Coding Plan): API-key
 * subscriptions a provider key pays through, with the names, links and
 * labels every host shows for them. Plain data, so browser webviews render
 * the same catalog; each plan names its switch's setting row, whose title is
 * the label every host shows for it. What a used-up plan falls back to is
 * the payment copy's (`planFallbackName` in `@ui/copy/modelAccess`), not
 * this catalog's.
 */
import {
  GLM_CODING_PLAN_SETTING,
  KIMI_CODE_PREFER_SETTING,
  type SettingRow,
} from '@texra-ai/harness/schemas';
import type { KeyPlanRoute } from '@texra-ai/llm';
import type { SubscriptionUsageProvider } from './subscriptionUsage';

/** One coding plan's identity and presentation, keyed by its usage route.
 *  The key that pays for it is `apiProvider`'s, so that provider's name and
 *  key page (`providerDisplayName`, `providerKeyUrl`) are the credential's. */
interface CodingPlanSubscriptionDescriptor {
  /** Also the key its usage is reported and cached under. */
  readonly id: SubscriptionUsageProvider;
  readonly apiProvider: 'glm' | 'kimiCode';
  readonly exclusiveCredential: boolean;
  readonly usageRoute: KeyPlanRoute;
  readonly displayName: string;
  /** The switch that routes the provider's models through the plan. */
  readonly preference: SettingRow<boolean>;
  readonly modelFamily: string;
}

/** Canonical catalog of coding-plan providers supported by every host. */
export const CODING_PLAN_SUBSCRIPTIONS = Object.freeze([
  Object.freeze({
    id: 'kimiCode',
    apiProvider: 'kimiCode',
    exclusiveCredential: true,
    usageRoute: 'kimi-code-subscription',
    displayName: 'Kimi Code',
    preference: KIMI_CODE_PREFER_SETTING,
    modelFamily: 'Kimi models',
  }),
  Object.freeze({
    id: 'glmCodingPlan',
    apiProvider: 'glm',
    exclusiveCredential: false,
    usageRoute: 'glm-coding-plan-subscription',
    displayName: 'GLM Coding Plan',
    preference: GLM_CODING_PLAN_SETTING,
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

/** Resolve a coding plan from the route stamped on completed usage. A
 *  plan's own route always resolves: the lookup is built from the catalog. */
export function codingPlanForUsageRoute(
  route: CodingPlanSubscription['usageRoute'],
): CodingPlanSubscription;
export function codingPlanForUsageRoute(
  route: string | undefined,
): CodingPlanSubscription | undefined;
export function codingPlanForUsageRoute(
  route: string | undefined,
): CodingPlanSubscription | undefined {
  return route === undefined
    ? undefined
    : CODING_PLAN_BY_USAGE_ROUTE.get(route);
}
