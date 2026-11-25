/** Subscription sign-in status, as the model access controllers report it
 *  and every host's account surface shows it. */
import { Schema } from 'effect';

import { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/worldline/schemas';

/**
 * Outbound: backend → frontend subscription sign-in status, addressed by
 * provider. One shape for every provider — both carry the same session facts
 * and the same routing preference — so the payload names the provider instead
 * of the command doing it.
 */
export const SubscriptionAuthStatusSchema = Schema.Struct({
  provider: Schema.Literals(SUBSCRIPTION_AUTH_PROVIDERS),
  signedIn: Schema.Boolean,
  email: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  /** How the account is named in a sentence: its email, or the provider's
   *  words for an account that names none. */
  accountLabel: Schema.String,
  preferSubscription: Schema.Boolean,
});
export type SubscriptionAuthStatus =
  (typeof SubscriptionAuthStatusSchema)['Type'];

/**
 * Sign-in status per provider, as a settings view holds it. Partial because a
 * provider that has not reported yet has no row; its section renders the
 * signed-out state until one lands.
 */
export type SubscriptionAuthStatuses = Readonly<
  Partial<Record<SubscriptionAuthStatus['provider'], SubscriptionAuthStatus>>
>;
