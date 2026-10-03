/** Subscription sign-in status, as the model access layer reports it and
 *  every host's account surface shows it. */
import { z } from 'zod';

/**
 * The OAuth subscription providers a settings view signs in and out of. The
 * wire vocabulary for `SubscriptionProvider.id` in the host-neutral catalog
 * (`@controllers/modelAccess/subscriptionProviders`), which derives its id
 * type from here so a provider is spelled one way everywhere.
 */
export const SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt', 'grok'] as const;

/**
 * Outbound: backend → frontend subscription sign-in status, addressed by
 * provider. One shape for every provider — both carry the same session facts
 * and the same routing preference — so the payload names the provider instead
 * of the command doing it.
 */
export const SubscriptionAuthStatusSchema = z.object({
  provider: z.enum(SUBSCRIPTION_AUTH_PROVIDERS),
  signedIn: z.boolean(),
  email: z.string().nullish(),
  accountId: z.string().nullish(),
  preferSubscription: z.boolean(),
});
export type SubscriptionAuthStatus = z.infer<
  typeof SubscriptionAuthStatusSchema
>;

/**
 * Sign-in status per provider, as a settings view holds it. Partial because a
 * provider that has not reported yet has no row; its section renders the
 * signed-out state until one lands.
 */
export type SubscriptionAuthStatuses = Readonly<
  Partial<Record<SubscriptionAuthStatus['provider'], SubscriptionAuthStatus>>
>;
