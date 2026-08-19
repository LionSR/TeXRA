/**
 * Wires TeXRA's account plane into the model layer.
 *
 * The model layer resolves credentials from `platform().secrets` and knows
 * nothing about TeXRA's "Sign in with ChatGPT" / "Sign in with X" flows. This
 * module is the one place those planes are handed to it, and every host
 * composition root calls it next to `initPlatform()`. Skip the call and the
 * model layer runs bring-your-own-key — which is exactly what an embedder of
 * the agent core gets.
 */

import { getCodexStatus } from '@auth/codex';
import { getXaiStatus } from '@auth/xai';
import { setCodexSignedInProbe } from '@model/codex/codexSignedIn';
import { setXaiSignedInProbe } from '@model/xai/xaiSignedIn';

/**
 * Install ChatGPT / Grok signed-in state into the model layer. Idempotent;
 * call once per process from the host composition root, immediately after
 * `initPlatform()`.
 */
export function installTexraAccountProbes(): void {
  setCodexSignedInProbe(async () => (await getCodexStatus()).signedIn);
  setXaiSignedInProbe(async () => (await getXaiStatus()).signedIn);
}
