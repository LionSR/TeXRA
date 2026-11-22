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
} from '@texra-ai/worldline/schemas';
import { type KeyPlanRoute, PLAN_ROUTES } from '@texra-ai/llm';
import type { SubscriptionUsageProvider } from './subscriptionUsage';

/** One coding plan's identity and presentation, as the catalog writes it.
 *  Its route is its key, and the key that pays for it is that route's
 *  provider (`PLAN_ROUTES`), so that provider's name and key page
 *  (`providerDisplayName`, `providerKeyUrl`) are the credential's. */
interface CodingPlanRow {
  /** Also the key its usage is reported and cached under. */
  readonly id: SubscriptionUsageProvider;
  readonly exclusiveCredential: boolean;
  readonly displayName: string;
  /** The switch that routes the provider's models through the plan. */
  readonly preference: SettingRow<boolean>;
  readonly modelFamily: string;
}

/** A catalog row with the two facts the route already holds: the route
 *  itself and the provider whose key pays for it. */
function codingPlan<R extends KeyPlanRoute, const T extends CodingPlanRow>(
  usageRoute: R,
  row: T,
) {
  return Object.freeze({
    ...row,
    usageRoute,
    apiProvider: PLAN_ROUTES[usageRoute].provider,
  });
}

/** Every coding plan, keyed by the route that bills through it: a key plan
 *  added to llm without a row here does not compile. */
const CODING_PLANS = Object.freeze({
  'kimi-code-subscription': codingPlan('kimi-code-subscription', {
    id: 'kimiCode',
    exclusiveCredential: true,
    displayName: 'Kimi Code',
    preference: KIMI_CODE_PREFER_SETTING,
    modelFamily: 'Kimi models',
  }),
  'glm-coding-plan-subscription': codingPlan('glm-coding-plan-subscription', {
    id: 'glmCodingPlan',
    exclusiveCredential: false,
    displayName: 'GLM Coding Plan',
    preference: GLM_CODING_PLAN_SETTING,
    modelFamily: 'GLM models',
  }),
} satisfies { readonly [R in KeyPlanRoute]: { readonly usageRoute: R } });

/** Canonical catalog of coding-plan providers supported by every host. */
export const CODING_PLAN_SUBSCRIPTIONS = Object.freeze(
  Object.values(CODING_PLANS),
);

/** One coding plan of the catalog. */
export type CodingPlanSubscription = (typeof CODING_PLAN_SUBSCRIPTIONS)[number];
/** The id of a coding plan. */
export type CodingPlanSubscriptionId = CodingPlanSubscription['id'];

/** The coding plan whose credential an API provider owns, by provider. */
export const CODING_PLAN_BY_API_PROVIDER: ReadonlyMap<
  string,
  CodingPlanSubscription
> = new Map(CODING_PLAN_SUBSCRIPTIONS.map((plan) => [plan.apiProvider, plan]));

/** Resolve a coding plan from the route stamped on completed usage. */
export function codingPlanForUsageRoute<R extends KeyPlanRoute>(
  route: R,
): (typeof CODING_PLANS)[R];
export function codingPlanForUsageRoute(
  route: string | undefined,
): CodingPlanSubscription | undefined;
export function codingPlanForUsageRoute(
  route: string | undefined,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_SUBSCRIPTIONS.find((plan) => plan.usageRoute === route);
}
