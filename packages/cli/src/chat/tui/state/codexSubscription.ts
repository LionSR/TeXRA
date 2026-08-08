import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  setPreferCodexSubscription,
  type CodexSubscriptionPreferenceUpdate,
} from '@model/codex/codexPreference';
import {
  setGLMCodingPlan,
  setPreferKimiCode,
} from '@utils/config/providerConfig';

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

/**
 * Flip the "Prefer Kimi Code" preference and refresh the TUI views. Shared by
 * the retry "switch to your own Moonshot API key" path so the
 * persist-then-refresh sequence lives in one place.
 */
export async function setCliKimiCode(enabled: boolean): Promise<void> {
  await setPreferKimiCode(enabled);
  refreshSubscriptionPreferenceViews();
}

/**
 * Flip the GLM Coding Plan toggle and refresh the TUI views. Shared by the
 * retry "switch to the regular GLM endpoint" path so the persist-then-refresh
 * sequence lives in one place.
 */
export async function setCliGlmCodingPlan(enabled: boolean): Promise<void> {
  await setGLMCodingPlan(enabled);
  refreshSubscriptionPreferenceViews();
}
