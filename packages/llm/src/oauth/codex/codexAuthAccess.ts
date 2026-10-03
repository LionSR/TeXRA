/**
 * Access to the Codex OAuth coordinator, over the secret store its caller
 * holds: one coordinator per store instance, so distinct stores never share
 * session state.
 */

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
} from '../sessionAccess.js';
import { CODEX_SESSION_SECRET_KEY } from './codexConstants.js';
import {
  CodexSessionCoordinator,
  type CodexSessionStatus,
} from './CodexSessionCoordinator.js';
import type { CredentialStore } from '../../providers/credentials.js';
import type { Effect } from 'effect';

const CHANNEL = 'codexAuth';

const coordinatorFor = createSecretBackedCoordinator({
  secretKey: CODEX_SESSION_SECRET_KEY,
  makeCoordinator: (storage) => new CodexSessionCoordinator({ storage }),
});

/** The coordinator for the caller's secret store. */
export function codexCoordinator(
  secrets: CredentialStore,
): CodexSessionCoordinator {
  return coordinatorFor(secrets);
}

/** Signed-in status, read from the caller's secret store. */
export function getCodexStatus(
  secrets: CredentialStore,
): Effect.Effect<CodexSessionStatus> {
  return getSubscriptionSessionStatus(
    () => codexCoordinator(secrets),
    CHANNEL,
    'ChatGPT',
  );
}
