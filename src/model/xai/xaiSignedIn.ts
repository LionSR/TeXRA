/**
 * Whether the user is signed in with Grok, as the model layer sees it. Probe
 * semantics (signed-out default, install-once) live in `../signedInProbe`.
 */
import { createSignedInProbe, type SignedInProbe } from '../signedInProbe';

const signedIn = createSignedInProbe();

/**
 * Install the app's Grok sign-in probe. Called once per process from the host
 * composition root.
 */
export function setXaiSignedInProbe(next: SignedInProbe): void {
  signedIn.setProbe(next);
}

/** Whether a Grok (xAI) subscription session is currently signed in. */
export function isXaiSignedIn(): Promise<boolean> {
  return signedIn.isSignedIn();
}
