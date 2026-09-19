/**
 * The ChatGPT (Codex) subscription, as the model layer sees it: the "prefer my
 * ChatGPT subscription" switch, and whether a session is signed in.
 *
 * The switch is off by default (experimental, opt-in). When on AND the user is
 * signed in with ChatGPT, Codex-eligible OpenAI models route through the
 * subscription instead of the user's API key. Probe semantics (signed-out
 * default, install-once) live in `../signedInProbe`; the OAuth machinery lives
 * outside the model layer, in `@auth/codex`.
 */
import { createSignedInProbe, type SignedInProbe } from '../signedInProbe';
import { createSubscriptionPreference } from '../subscriptionPreference';
import type { Effect } from 'effect';

/** Config key for the "prefer my ChatGPT subscription" switch (off by default). */
const CODEX_PREFER_SUBSCRIPTION_KEY = 'texra.chatgptCodex.preferSubscription';

const preference = createSubscriptionPreference(CODEX_PREFER_SUBSCRIPTION_KEY);

/** Whether the user has switched on "prefer ChatGPT subscription". */
export const isPreferCodexSubscription = preference.isPrefer;

/** Update the preference at the scope that currently controls its value. */
export const setPreferCodexSubscription = preference.setPrefer;

const signedIn = createSignedInProbe();

/**
 * Install the app's ChatGPT sign-in probe. Called once per process from the
 * host composition root.
 */
export function setCodexSignedInProbe(next: SignedInProbe): void {
  signedIn.setProbe(next);
}

/** Whether a ChatGPT (Codex) subscription session is currently signed in. */
export function isCodexSignedIn(): Effect.Effect<boolean> {
  return signedIn.isSignedIn();
}
