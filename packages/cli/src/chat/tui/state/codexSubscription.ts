import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { codingPlanSubscriptionRuntimes } from '@model/codingPlanSubscriptions';
import {
  setPreferCodexSubscription,
  type CodexSubscriptionPreferenceUpdate,
} from '@model/codex/codexPreference';
import type { CodingPlanSubscriptionId } from '@shared/codingPlanSubscriptions';

import { bumpCodexPreferenceVersion } from './cliState';

/**
 * Single source of truth for reacting to a subscription change (ChatGPT, Grok,
 * …) inside the running TUI: drop the cached model options and bump the
 * preference version so dependent views (model picker, status bar) re-render.
 * Call after any sign-in/out or preference flip.
 */
export function refreshSubscriptionPreferenceViews(): void {
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
  refreshSubscriptionPreferenceViews();
  return update;
}

/** Flip any catalogued coding-plan preference and refresh the TUI views. */
export async function setCliCodingPlanSubscription(
  id: CodingPlanSubscriptionId,
  enabled: boolean,
): Promise<void> {
  const runtime = codingPlanSubscriptionRuntimes.find(
    (candidate) => candidate.descriptor.id === id,
  );
  if (!runtime) throw new Error(`Unknown coding-plan subscription: ${id}`);
  await runtime.setEnabled(enabled);
  refreshSubscriptionPreferenceViews();
}
