/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import { createSubscriptionPreference } from '../subscriptionPreference';

/** Config key for the "prefer my ChatGPT subscription" switch (off by default). */
export const CODEX_PREFER_SUBSCRIPTION_KEY =
  'texra.chatgptCodex.preferSubscription';

const preference = createSubscriptionPreference(CODEX_PREFER_SUBSCRIPTION_KEY);

/** Whether the user has switched on "prefer ChatGPT subscription". */
export const isPreferCodexSubscription = preference.isPrefer;

/** Update the preference at the scope that currently controls its value. */
export const setPreferCodexSubscription = preference.setPrefer;
