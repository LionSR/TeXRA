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
import { Effect } from 'effect';

/** Reads the current sign-in state. Never fails; never hits the network. */
export type SignedInProbe = () => Effect.Effect<boolean>;

interface SignedInProbeSlot {
  /** Install the app's sign-in probe. */
  setProbe(next: SignedInProbe): void;
  isSignedIn(): Effect.Effect<boolean>;
}

/** Build a sign-in probe slot that reports signed-out until one is installed. */
export function createSignedInProbe(): SignedInProbeSlot {
  const SIGNED_OUT: SignedInProbe = () => Effect.succeed(false);
  let probe: SignedInProbe = SIGNED_OUT;
  return {
    setProbe(next) {
      probe = next;
    },
    isSignedIn() {
      return probe();
    },
  };
}
