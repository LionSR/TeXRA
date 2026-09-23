import { Effect } from 'effect';

import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import type { ConfigWriteFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Flip an OAuth subscription preference (ChatGPT, Grok) and refresh the TUI
 * views. The login commands and the access picker write it; nothing else
 * does, so the persist-then-refresh sequence lives in one place.
 */
export function setCliSubscriptionPreference(
  stores: SettingsStores,
  providerId: SubscriptionProviderId,
  enabled: boolean,
): Effect.Effect<void, ConfigWriteFailed | Error> {
  return subscriptionProvider(providerId)
    .setPreferSubscription(stores, enabled)
    .pipe(Effect.andThen(Effect.sync(bumpCodexPreferenceVersion)));
}
