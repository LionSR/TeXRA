import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscriptionId,
} from './codingPlanSubscriptions';
import type { ExhaustionReason } from './schemas/errors';

/**
 * One switchable quota-fallback route: when its usage quota is exhausted,
 * accepting "use your own API key" turns off this route's preference so the
 * same model retries on the fallback credential.
 *
 * Policy only — preference get/set lives in `@model/quotaFallbackRoutes`.
 * Keeping this module dependency-free lets the CLI classifier, retry
 * controller, and browser retry copy share one catalog.
 */
type OauthQuotaFallbackRouteId = 'chatgpt' | 'grok';
export type QuotaFallbackRouteId =
  OauthQuotaFallbackRouteId | CodingPlanSubscriptionId;

type QuotaFallbackExhaustionReason = Extract<
  ExhaustionReason,
  | 'chatgpt-subscription'
  | 'xai-subscription'
  | 'glm-coding-plan'
  | 'kimi-code-subscription'
>;

export interface QuotaFallbackRoute {
  readonly id: QuotaFallbackRouteId;
  readonly exhaustionReason: QuotaFallbackExhaustionReason;
  /** Direct-key provider the retry should prompt for, when it differs from
   *  the forwarded SDK provider. */
  readonly fallbackApiProvider?: 'openai' | 'xai';
  /** Whether accepting the switch must also turn off included (relay) access
   *  so the retry cannot still prefer the relay JWT. */
  readonly disableIncludedAccess: boolean;
  readonly retryFallbackName: string;
  readonly retrySourceName: string;
}

const OAUTH_QUOTA_FALLBACK_ROUTES = Object.freeze([
  Object.freeze({
    id: 'chatgpt',
    exhaustionReason: 'chatgpt-subscription',
    fallbackApiProvider: 'openai',
    disableIncludedAccess: true,
    retryFallbackName: 'your own OpenAI API key',
    retrySourceName: 'ChatGPT subscription',
  }),
  Object.freeze({
    id: 'grok',
    exhaustionReason: 'xai-subscription',
    fallbackApiProvider: 'xai',
    disableIncludedAccess: true,
    retryFallbackName: 'your own xAI API key',
    retrySourceName: 'Grok subscription',
  }),
] as const satisfies readonly QuotaFallbackRoute[]);

/** Canonical catalog of quota-fallback routes supported by every host. */
export const QUOTA_FALLBACK_ROUTES: readonly QuotaFallbackRoute[] =
  Object.freeze([
    ...OAUTH_QUOTA_FALLBACK_ROUTES,
    ...CODING_PLAN_SUBSCRIPTIONS.map((plan) =>
      Object.freeze({
        id: plan.id,
        exhaustionReason: plan.exhaustionReason,
        disableIncludedAccess: false,
        retryFallbackName: plan.retryFallbackName,
        retrySourceName: plan.retrySourceName,
      }),
    ),
  ]);

const ROUTE_BY_ID = new Map<QuotaFallbackRouteId, QuotaFallbackRoute>(
  QUOTA_FALLBACK_ROUTES.map((route) => [route.id, route]),
);

const ROUTE_BY_EXHAUSTION = new Map<ExhaustionReason, QuotaFallbackRoute>(
  QUOTA_FALLBACK_ROUTES.map((route) => [route.exhaustionReason, route]),
);

/** Resolve the quota-fallback route that a classified exhaustion should switch. */
export function quotaFallbackRouteForExhaustion(
  reason: ExhaustionReason | undefined,
): QuotaFallbackRoute | undefined {
  return reason === undefined ? undefined : ROUTE_BY_EXHAUSTION.get(reason);
}

/** Resolve a quota-fallback route by catalog id. */
export function quotaFallbackRouteById(
  id: QuotaFallbackRouteId,
): QuotaFallbackRoute | undefined {
  return ROUTE_BY_ID.get(id);
}

/** True when `id` is one of {@link CODING_PLAN_SUBSCRIPTIONS}. */
export function isCodingPlanQuotaRoute(
  id: QuotaFallbackRouteId,
): id is CodingPlanSubscriptionId {
  return CODING_PLAN_SUBSCRIPTIONS.some((plan) => plan.id === id);
}
