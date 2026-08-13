import {
  setPreferXaiSubscription,
  type XaiSubscriptionPreferenceUpdate,
} from '@model/xai/xaiPreference';

import { refreshSubscriptionPreferenceViews } from './codexSubscription';

/**
 * Flip the "prefer Grok subscription" preference and refresh TUI views that
 * depend on subscription routing (model picker, status bar). Reuses the same
 * preference-version signal as ChatGPT so one bump refreshes both.
 */
export async function setCliXaiSubscription(
  enabled: boolean,
): Promise<XaiSubscriptionPreferenceUpdate> {
  const update = await setPreferXaiSubscription(enabled);
  refreshSubscriptionPreferenceViews();
  return update;
}
