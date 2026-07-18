import {
  setPreferCodexSubscription,
  type CodexSubscriptionPreferenceUpdate,
} from '@auth/codex';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Single source of truth for reacting to a Codex / ChatGPT-subscription change
 * inside the running TUI: drop the cached model options and bump the preference
 * version so dependent views (model picker, status bar) re-render. Call after
 * any sign-in/out or preference flip.
 */
export function refreshCodexPreferenceViews(): void {
  invalidateModelOptionsCache();
  bumpCodexPreferenceVersion();
}

/**
 * Flip the "prefer ChatGPT subscription" preference and refresh the TUI views.
 * Shared by ChatGPT login and the retry "switch to your own API key" path so
 * the persist-then-refresh sequence lives in one place.
 */
export async function setCliCodexSubscription(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const update = await setPreferCodexSubscription(enabled);
  refreshCodexPreferenceViews();
  return update;
}
