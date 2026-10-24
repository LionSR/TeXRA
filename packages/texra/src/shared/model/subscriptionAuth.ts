/** Subscription sign-in status, as the model access controllers report it
 *  and every host's account surface shows it, and how its account is named. */
import { Schema } from 'effect';

import { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/harness/schemas';

/**
 * Outbound: backend → frontend subscription sign-in status, addressed by
 * provider. One shape for every provider — both carry the same session facts
 * and the same routing preference — so the payload names the provider instead
 * of the command doing it.
 */
export const SubscriptionAuthStatusSchema = Schema.Struct({
  provider: Schema.Enum(SUBSCRIPTION_AUTH_PROVIDERS),
  signedIn: Schema.Boolean,
  email: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
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

/**
 * How a ChatGPT account is named in user-facing text, from a session, a
 * coordinator status, or the settings wire payload — all of which carry the
 * same optional `email`/`accountId` pair. The email is the identity a user
 * recognizes; the account id is the only other identifier the token carries.
 */
export function codexAccountLabel(
  account:
    | { readonly email?: string | null; readonly accountId?: string | null }
    | null
    | undefined,
): string {
  return account?.email ?? account?.accountId ?? 'your ChatGPT account';
}

/** How a Grok account is named in user-facing text: its email, if known. */
export function xaiAccountLabel(
  account: { readonly email?: string | null } | null | undefined,
): string {
  return account?.email ?? 'your Grok account';
}
