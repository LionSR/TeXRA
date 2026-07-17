import {
  setPreferKimiCodeSubscription,
  type KimiCodeSubscriptionPreferenceUpdate,
} from '@auth/kimiCode';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Single source of truth for reacting to a Kimi Code subscription change
 * inside the running TUI: drop the cached model options and bump the shared
 * subscription-preference version so dependent views (model picker, status
 * bar) re-render. Call after any sign-in/out or preference flip.
 */
export function refreshKimiCodePreferenceViews(): void {
  invalidateModelOptionsCache();
  bumpCodexPreferenceVersion();
}

/**
 * Flip the "prefer Kimi Code subscription" preference and refresh the TUI
 * views, keeping the persist-then-refresh sequence in one place.
 */
export async function setCliKimiCodeSubscription(
  enabled: boolean,
): Promise<KimiCodeSubscriptionPreferenceUpdate> {
  const update = await setPreferKimiCodeSubscription(enabled);
  refreshKimiCodePreferenceViews();
  return update;
}
