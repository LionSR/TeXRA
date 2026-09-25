import { CHATGPT_AUTH, GROK_AUTH } from '@ui/copy/accountAuth';
import { CODING_PLAN_SUBSCRIPTIONS } from './codingPlanSubscriptions';
import type { ExhaustionReason } from './schemas/errors';
import type { DeclinableUsageRoute } from './schemas/usage';

/**
 * One switchable quota-fallback route: when its usage quota is exhausted, a
 * retry on the user's own credential declines this route for the run so the
 * same model retries on its own provider key.
 *
 * Copy and detection only: whether a failure offers the switch is the retry
 * owner's decision (`ModelInvoker`), carried on the retry request. Keeping
 * this module dependency-free lets the error formatter, the invoker, and the
 * CLI retry copy share one catalog.
 */
export type QuotaFallbackExhaustionReason = Extract<
  ExhaustionReason,
  | 'chatgpt-subscription'
  | 'xai-subscription'
  | 'glm-coding-plan'
  | 'kimi-code-subscription'
>;

export interface QuotaFallbackRoute {
  readonly usageRoute: DeclinableUsageRoute;
  readonly exhaustionReason: QuotaFallbackExhaustionReason;
  readonly retryFallbackName: string;
  readonly retrySourceName: string;
}

/** Canonical catalog of quota-fallback routes supported by every host. */
export const QUOTA_FALLBACK_ROUTES: readonly QuotaFallbackRoute[] =
  Object.freeze([
    Object.freeze({
      usageRoute: 'chatgpt-subscription',
      exhaustionReason: 'chatgpt-subscription',
      retryFallbackName: 'your own OpenAI API key',
      retrySourceName: CHATGPT_AUTH.subscriptionLabel,
    }),
    Object.freeze({
      usageRoute: 'xai-subscription',
      exhaustionReason: 'xai-subscription',
      retryFallbackName: 'your own xAI API key',
      retrySourceName: GROK_AUTH.subscriptionLabel,
    }),
    ...CODING_PLAN_SUBSCRIPTIONS.map((plan) =>
      Object.freeze({
        usageRoute: plan.usageRoute,
        exhaustionReason: plan.exhaustionReason,
        retryFallbackName: plan.retryFallbackName,
        retrySourceName: plan.retrySourceName,
      }),
    ),
  ]);

const ROUTE_BY_USAGE = new Map<DeclinableUsageRoute, QuotaFallbackRoute>(
  QUOTA_FALLBACK_ROUTES.map((route) => [route.usageRoute, route]),
);

/** The catalog entry of a declinable route. Every declinable route has one. */
export function quotaFallbackRouteFor(
  usageRoute: DeclinableUsageRoute,
): QuotaFallbackRoute {
  const route = ROUTE_BY_USAGE.get(usageRoute);
  if (route === undefined) {
    throw new Error(`No quota-fallback route for ${usageRoute}.`);
  }
  return route;
}
