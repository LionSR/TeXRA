/**
 * Wires TeXRA's account state and diagnostics into the model layer.
 *
 * The model layer resolves credentials from `platform().secrets` but knows
 * nothing about TeXRA's sign-in flows or logger. This module is the one place
 * those app services are handed to it, and every host composition root calls
 * it next to `initPlatform()`. Without that call, an embedder gets
 * bring-your-own-key behavior and silent picker diagnostics.
 */

import { getCodexStatus } from '@auth/codex';
import { getXaiStatus } from '@auth/xai';
import { createLog } from '@logger/logUtils';
import { setModelAvailabilityWarningSink } from '@model/modelAvailabilityWarning';
import { setCodexSignedInProbe } from '@model/codex/codexSignedIn';
import { setXaiSignedInProbe } from '@model/xai/xaiSignedIn';

const log = createLog('computeModelOptions');

/**
 * Install ChatGPT / Grok signed-in state and model-picker diagnostics. Idempotent;
 * call once per process from the host composition root, immediately after
 * `initPlatform()`.
 */
export function installTexraAccountProbes(): void {
  setCodexSignedInProbe(async () => (await getCodexStatus()).signedIn);
  setXaiSignedInProbe(async () => (await getXaiStatus()).signedIn);
  setModelAvailabilityWarningSink((message, error) => {
    log.warn(message, { data: error });
  });
}
