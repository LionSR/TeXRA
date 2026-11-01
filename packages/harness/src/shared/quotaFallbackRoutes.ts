import { SUBSCRIPTION_AUTH_NAMES } from '@shared/model/subscriptionAuth';
import type { DeclinableUsageRoute } from './schemas/usage';
import type { ExhaustionReason } from './schemas/errors';

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
export type QuotaFallbackExhaustionReason = Exclude<
  ExhaustionReason,
  'upstream-credit'
>;

export interface QuotaFallbackRoute {
  readonly exhaustionReason: QuotaFallbackExhaustionReason;
  readonly retryFallbackName: string;
  readonly retrySourceName: string;
}

/** Canonical catalog of quota-fallback routes supported by every host, one
 *  per declinable route. */
const QUOTA_FALLBACK_ROUTES: Readonly<
  Record<DeclinableUsageRoute, QuotaFallbackRoute>
> = Object.freeze({
  'chatgpt-subscription': Object.freeze({
    exhaustionReason: 'chatgpt-subscription',
    retryFallbackName: 'your own OpenAI API key',
    retrySourceName: SUBSCRIPTION_AUTH_NAMES.chatgpt.subscriptionLabel,
  }),
  'xai-subscription': Object.freeze({
    exhaustionReason: 'xai-subscription',
    retryFallbackName: 'your own xAI API key',
    retrySourceName: SUBSCRIPTION_AUTH_NAMES.grok.subscriptionLabel,
  }),
  'kimi-code-subscription': Object.freeze({
    exhaustionReason: 'kimi-code-subscription',
    retryFallbackName: 'your own Moonshot API keys',
    retrySourceName: 'Kimi Code subscription',
  }),
  'glm-coding-plan-subscription': Object.freeze({
    exhaustionReason: 'glm-coding-plan',
    retryFallbackName: 'the regular GLM endpoint',
    retrySourceName: 'GLM Coding Plan',
  }),
});

/** The catalog entry of a declinable route. */
export function quotaFallbackRouteFor(
  usageRoute: DeclinableUsageRoute,
): QuotaFallbackRoute {
  return QUOTA_FALLBACK_ROUTES[usageRoute];
}
