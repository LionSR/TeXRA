/**
 * The subscription sign-in status as the settings views consume it: the
 * session status plus the current routing preference, tagged with the provider
 * it belongs to. One composer so the extension and desktop hosts post the
 * identical payload (the wire shape is validated by
 * `SubscriptionAuthStatusSchema` at each host's boundary).
 *
 * Lives beside the catalog rather than in `@auth/**` so the model layer's
 * subscription preferences stay reachable without depending on the OAuth
 * machinery; both facts already hang off the catalog row.
 */
import { Effect } from 'effect';

import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type {
  SubscriptionAuthStatus,
} from '@shared/settingsView/settingsViewMessages';

export function subscriptionAuthStatus(
  providerId: SubscriptionProviderId,
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<SubscriptionAuthStatus> {
  const provider = subscriptionProvider(providerId);
  return Effect.map(provider.getStatus(secrets), (status) => ({
    provider: providerId,
    signedIn: status.signedIn,
    email: status.email,
    accountId: status.accountId,
    preferSubscription: provider.isPreferSubscription(stores),
  }));
}
