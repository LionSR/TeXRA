import { Effect } from 'effect';

import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import type { ConfigWriteFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Flip an OAuth subscription preference (ChatGPT, Grok) on `/login` and
 * refresh the TUI views. The access picker, sign-out, `/config` and the key
 * prompt write access state through their own paths and bump
 * `codexPreferenceVersion` themselves.
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
