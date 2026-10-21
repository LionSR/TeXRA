/**
 * The OAuth subscriptions model calls can route through, and the names the
 * harness's own text gives each one.
 *
 * The switch that routes eligible models through a subscription is named by
 * the subscription itself — `subscriptionLabel`, "ChatGPT subscription" — and
 * never by a verb. It selects a credential rather than expressing a preference
 * among them: a session that cannot be read fails the run and asks the user to
 * sign in again, so a "Prefer …" label would promise a fallback to the API key
 * that routing does not perform. One noun also keeps the switch recognizable
 * in the row that toggles it and in the hint that quotes it back.
 */

/**
 * The subscription providers, as a settings view signs in and out of them:
 * the one spelling of a provider id everywhere.
 */
export const SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt', 'grok'] as const;

export type SubscriptionAuthProvider =
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number];

/**
 * Each subscription's switch, and the sign-in a lapsed session asks for: the
 * names a model-access failure, a quota fallback and a picker quote, and the
 * ones every host's account copy repeats.
 */
export const SUBSCRIPTION_AUTH_NAMES = {
  chatgpt: {
    subscriptionLabel: 'ChatGPT subscription',
    signInLabel: 'Sign in with ChatGPT',
  },
  grok: {
    subscriptionLabel: 'Grok subscription',
    signInLabel: 'Sign in with Grok',
  },
} as const satisfies Record<
  SubscriptionAuthProvider,
  { readonly subscriptionLabel: string; readonly signInLabel: string }
>;
