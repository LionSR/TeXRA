/**
 * The "prefer my Grok subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * Grok, xAI models route through the OAuth access token instead of the user's
 * API key.
 */
import {
  createSubscriptionPreference,
  type SubscriptionPreferenceUpdate,
} from '../subscriptionPreference';

/** Config key for the "prefer my Grok subscription" switch (off by default). */
const XAI_PREFER_SUBSCRIPTION_KEY = 'texra.xaiGrok.preferSubscription';

export type XaiSubscriptionPreferenceUpdate = SubscriptionPreferenceUpdate;

const preference = createSubscriptionPreference(XAI_PREFER_SUBSCRIPTION_KEY);

/** Whether the user has switched on "prefer Grok subscription". */
export function isPreferXaiSubscription(): boolean {
  return preference.isPrefer();
}

/** Update the preference at the scope that currently controls its value. */
export async function setPreferXaiSubscription(
  enabled: boolean,
): Promise<XaiSubscriptionPreferenceUpdate> {
  return preference.setPrefer(enabled);
}
