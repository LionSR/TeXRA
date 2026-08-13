/**
 * Shared "is the user signed in with their subscription" probe used by ChatGPT
 * and Grok.
 *
 * The OAuth session machinery lives outside the model layer (`@auth/*`), so
 * the model layer holds only the answer, not the plumbing: an app that
 * supports subscription sign-in installs a probe at startup, and an embedder
 * that does not simply never signs in. Signed out is the honest default — it
 * routes model selection to API keys rather than to a subscription that cannot
 * be reached.
 */

/** Reads the current sign-in state. Never throws; never hits the network. */
export type SignedInProbe = () => Promise<boolean>;

export interface SignedInProbeSlot {
  /** Install the app's sign-in probe, or pass `null` to restore the default. */
  setProbe(next: SignedInProbe | null): void;
  isSignedIn(): Promise<boolean>;
}

/** Build a sign-in probe slot that reports signed-out until one is installed. */
export function createSignedInProbe(): SignedInProbeSlot {
  const SIGNED_OUT: SignedInProbe = async () => false;
  let probe: SignedInProbe = SIGNED_OUT;
  return {
    setProbe(next) {
      probe = next ?? SIGNED_OUT;
    },
    isSignedIn() {
      return probe();
    },
  };
}
