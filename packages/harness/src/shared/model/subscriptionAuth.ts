/**
 * The subscription providers, as a settings view signs in and out of them:
 * the one spelling of a provider id everywhere. What a person calls each
 * subscription and its sign-in is an app's copy; the harness's own failure
 * text names a subscription by the provider it bills.
 */
export const SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt', 'grok'] as const;

export type SubscriptionAuthProvider =
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number];
