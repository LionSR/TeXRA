/**
 * Whether the user is signed in with Grok, as the model layer sees it.
 *
 * The OAuth session machinery lives outside this layer (`@auth/xai`), so the
 * model layer holds only the answer, not the plumbing.
 */

/** Reads the current Grok sign-in state. Never throws; never hits the network. */
export type XaiSignedInProbe = () => Promise<boolean>;

const SIGNED_OUT: XaiSignedInProbe = async () => false;

let probe: XaiSignedInProbe = SIGNED_OUT;

/**
 * Install the app's Grok sign-in probe, or pass `null` to restore the
 * signed-out default. Called once per process from the host composition root.
 */
export function setXaiSignedInProbe(next: XaiSignedInProbe | null): void {
  probe = next ?? SIGNED_OUT;
}

/** Whether a Grok (xAI) subscription session is currently signed in. */
export function isXaiSignedIn(): Promise<boolean> {
  return probe();
}
