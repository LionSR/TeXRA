/**
 * Whether the user is signed in with ChatGPT, as the model layer sees it.
 * Probe semantics (signed-out default, install-once) live in
 * `../signedInProbe`.
 */
import { createSignedInProbe, type SignedInProbe } from '../signedInProbe';

const signedIn = createSignedInProbe();

/**
 * Install the app's ChatGPT sign-in probe. Called once per process from the
 * host composition root.
 */
export function setCodexSignedInProbe(next: SignedInProbe): void {
  signedIn.setProbe(next);
}

/** Whether a ChatGPT (Codex) subscription session is currently signed in. */
export function isCodexSignedIn(): Promise<boolean> {
  return signedIn.isSignedIn();
}
