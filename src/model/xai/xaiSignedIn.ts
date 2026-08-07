/**
 * Whether the user is signed in with Grok, as the model layer sees it. Probe
 * semantics (signed-out default, install-once) live in `../signedInProbe`.
 */
import { createSignedInProbe, type SignedInProbe } from '../signedInProbe';

/** Reads the current Grok sign-in state. Never throws; never hits the network. */
export type XaiSignedInProbe = SignedInProbe;

const signedIn = createSignedInProbe();

/**
 * Install the app's Grok sign-in probe, or pass `null` to restore the
 * signed-out default. Called once per process from the host composition root.
 */
export function setXaiSignedInProbe(next: XaiSignedInProbe | null): void {
  signedIn.setProbe(next);
}

/** Whether a Grok (xAI) subscription session is currently signed in. */
export function isXaiSignedIn(): Promise<boolean> {
  return signedIn.isSignedIn();
}
