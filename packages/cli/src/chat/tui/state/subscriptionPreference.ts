import { Effect } from 'effect';

import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import type { SubscriptionPreferenceUpdate } from '@model/subscriptionPreference';
import type { ConfigWriteFailed } from '@platform/interfaces';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Flip an OAuth subscription preference (ChatGPT, Grok) and refresh the TUI
 * views. The login commands and the access picker write it; nothing else
 * does, so the persist-then-refresh sequence lives in one place.
 */
export function setCliSubscriptionPreference(
  providerId: SubscriptionProviderId,
  enabled: boolean,
): Effect.Effect<SubscriptionPreferenceUpdate, ConfigWriteFailed> {
  return subscriptionProvider(providerId)
    .setPreferSubscription(enabled)
    .pipe(
      Effect.map((update) => {
        bumpCodexPreferenceVersion();
        return update;
      }),
    );
}
