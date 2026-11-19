/**
 * The subscription providers, as a settings view signs in and out of them:
 * the one spelling of a provider id everywhere. What a person calls each
 * subscription and its sign-in is an app's copy; the harness's own failure
 * text names a subscription by the provider it bills.
 */
import { Struct } from 'effect';
import type { CredentialRoute } from '@texra-ai/llm';

/** A plan that bills a signed-in subscription session. */
type SessionPlanRoute = Extract<CredentialRoute, { kind: 'session' }>['plan'];

/**
 * The route each provider's session bills, which names its account
 * (`SubscriptionAccounts`). The ids are stable.
 */
export const SUBSCRIPTION_ROUTES = Object.freeze({
  chatgpt: 'chatgpt-subscription',
  grok: 'xai-subscription',
}) satisfies Readonly<Record<string, SessionPlanRoute>>;

type AssertNever<T extends never> = T;
/** Every session plan has a sign-in: a plan added to llm without a row
 *  above fails here. */
type _EverySessionPlanSignsIn = AssertNever<
  Exclude<
    SessionPlanRoute,
    (typeof SUBSCRIPTION_ROUTES)[SubscriptionAuthProvider]
  >
>;

export type SubscriptionAuthProvider = keyof typeof SUBSCRIPTION_ROUTES;

export const SUBSCRIPTION_AUTH_PROVIDERS = Object.freeze(
  Struct.keys(SUBSCRIPTION_ROUTES),
);

/** Whether `id` names one of {@link SUBSCRIPTION_AUTH_PROVIDERS}. */
export const isSubscriptionAuthProvider = (
  id: string,
): id is SubscriptionAuthProvider =>
  SUBSCRIPTION_AUTH_PROVIDERS.some((provider) => provider === id);
