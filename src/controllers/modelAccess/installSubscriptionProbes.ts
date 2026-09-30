/**
 * Wires the ChatGPT and Grok subscription sign-in state into the model layer.
 *
 * The model layer resolves credentials but knows nothing about provider
 * sign-in flows. This module is the one place those app services are handed to
 * it, and every host composition root calls it with the secret store it
 * opened. Without that call, an embedder gets bring-your-own-key behavior.
 */

import { Effect } from 'effect';

import { getCodexStatus } from '@auth/codex';
import { getXaiStatus } from '@auth/xai';
import { setSignedInProbe } from '@model/subscriptionAccess';
import type { PlatformSecrets } from '@platform/secrets';

/**
 * Install ChatGPT / Grok signed-in state. Idempotent;
 * call once per process from the host composition root, with the secret store
 * that root opened: the probes close over it so the model layer stays
 * secrets-free.
 */
export function installSubscriptionProbes(secrets: PlatformSecrets): void {
  setSignedInProbe('chatgpt', () =>
    Effect.map(getCodexStatus(secrets), (status) => status.signedIn),
  );
  setSignedInProbe('grok', () =>
    Effect.map(getXaiStatus(secrets), (status) => status.signedIn),
  );
}
