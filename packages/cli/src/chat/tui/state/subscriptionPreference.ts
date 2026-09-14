import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { Effect } from 'effect';
import type { SubscriptionPreferenceUpdate } from '@model/subscriptionPreference';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Flip an OAuth subscription preference (ChatGPT, Grok) and refresh the TUI
 * views. The login commands and the access picker write it; nothing else
 * does, so the persist-then-refresh sequence lives in one place.
 */
export const setCliSubscriptionPreference = Effect.fn(
  'cli.setCliSubscriptionPreference',
)(function* (providerId: SubscriptionProviderId, enabled: boolean) {
  const update =
    yield* subscriptionProvider(providerId).setPreferSubscription(enabled);
  bumpCodexPreferenceVersion();
  return update satisfies SubscriptionPreferenceUpdate;
});
