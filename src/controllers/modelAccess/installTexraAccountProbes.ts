/**
 * Wires TeXRA's account state and diagnostics into the model layer.
 *
 * The model layer resolves credentials but knows nothing about TeXRA's sign-in
 * flows or logger. This module is the one place those app services are handed
 * to it, and every host composition root calls it with the secret store it
 * opened. Without that call, an embedder gets bring-your-own-key behavior and
 * silent picker diagnostics.
 */

import { getCodexStatus } from '@auth/codex';
import { getXaiStatus } from '@auth/xai';
import { createLog } from '@logger/logUtils';
import { setModelAvailabilityWarningSink } from '@model/modelAvailabilityWarning';
import { setCodexSignedInProbe } from '@model/codex/codexSignedIn';
import { setXaiSignedInProbe } from '@model/xai/xaiSignedIn';
import type { PlatformSecrets } from '@platform/secrets';

const log = createLog('computeModelOptions');

/**
 * Install ChatGPT / Grok signed-in state and model-picker diagnostics. Idempotent;
 * call once per process from the host composition root, with the secret store
 * that root opened: the probes close over it so the model layer stays
 * secrets-free.
 */
export function installTexraAccountProbes(secrets: PlatformSecrets): void {
  setCodexSignedInProbe(async () => (await getCodexStatus(secrets)).signedIn);
  setXaiSignedInProbe(async () => (await getXaiStatus(secrets)).signedIn);
  setModelAvailabilityWarningSink((message, error) => {
    log.warn(message, { data: error });
  });
}
