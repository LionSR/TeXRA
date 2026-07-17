/**
 * The "prefer my Kimi Code subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in
 * with Kimi Code, kimi-subscription-eligible Moonshot models route through the
 * subscription's OAuth session. Note the console API key is NOT gated by this
 * switch — the key is a documented plain credential for the same endpoint.
 */
import { createSubscriptionPreference } from '../shared/subscriptionPreference';
import {
  KIMI_CODE_PREFER_SUBSCRIPTION_KEY,
  KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
} from './kimiCodeConstants';
import type { SubscriptionPreferenceUpdate } from '../shared/subscriptionPreference';

export type KimiCodeSubscriptionPreferenceUpdate = SubscriptionPreferenceUpdate;

const preference = createSubscriptionPreference({
  preferKey: KIMI_CODE_PREFER_SUBSCRIPTION_KEY,
  toolUseOnlyKey: KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
});

/** Whether the user has switched on "prefer Kimi Code subscription". */
export const isPreferKimiCodeSubscription = preference.isPreferSubscription;

/**
 * Whether the Kimi Code subscription is restricted to tool-use agents (off by
 * default). When true, workflow agents skip the OAuth session and fall back to
 * the Kimi Code console API key — without one they fail, since these models
 * are not served by any other route. Read per request by the handler.
 */
export const isKimiCodeSubscriptionToolUseOnly = preference.isToolUseOnly;

/** Update the "subscription for tool-use only" switch at the controlling scope. */
export const setKimiCodeSubscriptionToolUseOnly = preference.setToolUseOnly;

/** Update the preference at the scope that currently controls its value. */
export const setPreferKimiCodeSubscription = preference.setPreferSubscription;
