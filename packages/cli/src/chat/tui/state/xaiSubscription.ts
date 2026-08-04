import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  setPreferXaiSubscription,
  type XaiSubscriptionPreferenceUpdate,
} from '@model/xai/xaiPreference';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Flip the "prefer Grok subscription" preference and refresh TUI views that
 * depend on subscription routing (model picker, status bar). Reuses the same
 * preference-version signal as ChatGPT so one bump refreshes both.
 */
export async function setCliXaiSubscription(
  enabled: boolean,
): Promise<XaiSubscriptionPreferenceUpdate> {
  const update = await setPreferXaiSubscription(enabled);
  invalidateModelOptionsCache();
  bumpCodexPreferenceVersion();
  return update;
}
