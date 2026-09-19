/**
 * The Grok (xAI) subscription, as the model layer sees it: the "prefer my Grok
 * subscription" switch, and whether a session is signed in.
 *
 * The switch is off by default (experimental, opt-in). When on AND the user is
 * signed in with Grok, xAI models route through the OAuth access token instead
 * of the user's API key. Probe semantics (signed-out default, install-once)
 * live in `../signedInProbe`; the OAuth machinery lives outside the model
 * layer, in `@auth/xai`.
 */
import { createSignedInProbe, type SignedInProbe } from '../signedInProbe';
import { createSubscriptionPreference } from '../subscriptionPreference';
import type { Effect } from 'effect';

/** Config key for the "prefer my Grok subscription" switch (off by default). */
const XAI_PREFER_SUBSCRIPTION_KEY = 'texra.xaiGrok.preferSubscription';

const preference = createSubscriptionPreference(XAI_PREFER_SUBSCRIPTION_KEY);

/** Whether the user has switched on "prefer Grok subscription". */
export const isPreferXaiSubscription = preference.isPrefer;

/** Update the preference at the scope that currently controls its value. */
export const setPreferXaiSubscription = preference.setPrefer;

const signedIn = createSignedInProbe();

/**
 * Install the app's Grok sign-in probe. Called once per process from the host
 * composition root.
 */
export function setXaiSignedInProbe(next: SignedInProbe): void {
  signedIn.setProbe(next);
}

/** Whether a Grok (xAI) subscription session is currently signed in. */
export function isXaiSignedIn(): Effect.Effect<boolean> {
  return signedIn.isSignedIn();
}
