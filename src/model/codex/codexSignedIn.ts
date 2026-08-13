/**
 * Whether the user is signed in with ChatGPT, as the model layer sees it.
 * Probe semantics (signed-out default, install-once) live in
 * `../signedInProbe`.
 */
import { createSignedInProbe, type SignedInProbe } from '../signedInProbe';

const signedIn = createSignedInProbe();

/**
 * Install the app's ChatGPT sign-in probe, or pass `null` to restore the
 * signed-out default. Called once per process from the host composition root.
 */
export function setCodexSignedInProbe(next: SignedInProbe | null): void {
  signedIn.setProbe(next);
}

/** Whether a ChatGPT (Codex) subscription session is currently signed in. */
export function isCodexSignedIn(): Promise<boolean> {
  return signedIn.isSignedIn();
}
