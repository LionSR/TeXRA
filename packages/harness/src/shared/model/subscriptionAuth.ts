/**
 * The subscription providers, as a settings view signs in and out of them:
 * the one spelling of a provider id everywhere. What a person calls each
 * subscription and its sign-in is an app's copy; the harness's own failure
 * text names a subscription by the provider it bills.
 */
import type { SubscriptionSessionRouteSchema } from '@shared/schemas/errors';

export const SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt', 'grok'] as const;

export type SubscriptionAuthProvider =
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number];

/**
 * The route each provider's session bills, which names its account
 * (`SubscriptionAccounts`). The ids are stable.
 */
export const SUBSCRIPTION_ROUTES = Object.freeze({
  chatgpt: 'chatgpt-subscription',
  grok: 'xai-subscription',
}) satisfies Readonly<
  Record<SubscriptionAuthProvider, typeof SubscriptionSessionRouteSchema.Type>
>;
