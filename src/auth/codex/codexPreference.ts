/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import { createSubscriptionPreference } from '../shared/subscriptionPreference';
import {
  CODEX_PREFER_SUBSCRIPTION_KEY,
  CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
} from './codexConstants';
import type { SubscriptionPreferenceUpdate } from '../shared/subscriptionPreference';

export type CodexSubscriptionPreferenceUpdate = SubscriptionPreferenceUpdate;

const preference = createSubscriptionPreference({
  preferKey: CODEX_PREFER_SUBSCRIPTION_KEY,
  toolUseOnlyKey: CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
});

/** Whether the user has switched on "prefer ChatGPT subscription". */
export const isPreferCodexSubscription = preference.isPreferSubscription;

/**
 * Whether the ChatGPT subscription is restricted to tool-use agents (off by
 * default). When true, workflow agents skip the subscription and route through
 * the user's API key / relay — the Codex backend has no background mode and is
 * less stable for long workflow runs. Read per request by the Codex handler.
 */
export const isCodexSubscriptionToolUseOnly = preference.isToolUseOnly;

/** Update the "subscription for tool-use only" switch at the controlling scope. */
export const setCodexSubscriptionToolUseOnly = preference.setToolUseOnly;

/** Update the preference at the scope that currently controls its value. */
export const setPreferCodexSubscription = preference.setPreferSubscription;
