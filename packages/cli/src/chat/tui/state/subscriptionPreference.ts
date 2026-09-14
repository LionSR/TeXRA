import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import type { SubscriptionPreferenceUpdate } from '@model/subscriptionPreference';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Flip an OAuth subscription preference (ChatGPT, Grok) and refresh the TUI
 * views. The login commands and the access picker write it; nothing else
 * does, so the persist-then-refresh sequence lives in one place.
 */
export async function setCliSubscriptionPreference(
  providerId: SubscriptionProviderId,
  enabled: boolean,
): Promise<SubscriptionPreferenceUpdate> {
  const update =
    await subscriptionProvider(providerId).setPreferSubscription(enabled);
  bumpCodexPreferenceVersion();
  return update;
}
