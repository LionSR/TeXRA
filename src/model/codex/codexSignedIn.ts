/**
 * Whether the user is signed in with ChatGPT, as the model layer sees it.
 *
 * The OAuth session machinery lives outside this layer (`@auth/codex`), so the
 * model layer holds only the answer, not the plumbing: an app that supports
 * "Sign in with ChatGPT" installs a probe at startup, and an embedder that does
 * not simply never signs in. Signed out is the honest default — it routes model
 * selection to API keys rather than to a subscription that cannot be reached.
 */

/** Reads the current ChatGPT sign-in state. Never throws; never hits the network. */
export type CodexSignedInProbe = () => Promise<boolean>;

const SIGNED_OUT: CodexSignedInProbe = async () => false;

let probe: CodexSignedInProbe = SIGNED_OUT;

/**
 * Install the app's ChatGPT sign-in probe, or pass `null` to restore the
 * signed-out default. Called once per process from the host composition root.
 */
export function setCodexSignedInProbe(next: CodexSignedInProbe | null): void {
  probe = next ?? SIGNED_OUT;
}

/** Whether a ChatGPT (Codex) subscription session is currently signed in. */
export function isCodexSignedIn(): Promise<boolean> {
  return probe();
}
