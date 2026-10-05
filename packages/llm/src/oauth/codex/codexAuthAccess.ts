/**
 * Access to the Codex OAuth coordinator, over the secret store its caller
 * holds: one coordinator per store instance, so distinct stores never share
 * session state.
 */

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
} from '../sessionAccess.js';
import {
  SubscriptionOAuthCoordinator,
  type SubscriptionSessionStatus,
} from '../SubscriptionOAuthCoordinator.js';
import { defineLoopbackLogin } from '../loopbackLogin.js';
import {
  CODEX_CALLBACK_FALLBACK_PORT,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
  CODEX_SESSION_SECRET_KEY,
} from './codexConstants.js';
import { CODEX_POLICY } from './codexSessionPolicy.js';
import type { CredentialStore } from '../../providers/credentials.js';
import type { CodexSession } from './codexSessionTypes.js';
import type { Effect } from 'effect';

const CHANNEL = 'codexAuth';

/** The coordinator for the caller's secret store. */
export const codexCoordinator: (
  secrets: CredentialStore,
) => SubscriptionOAuthCoordinator<CodexSession> = createSecretBackedCoordinator(
  {
    secretKey: CODEX_SESSION_SECRET_KEY,
    makeCoordinator: (storage) =>
      new SubscriptionOAuthCoordinator({ storage, policy: CODEX_POLICY }),
  },
);

/** Signed-in status, read from the caller's secret store. */
export function getCodexStatus(
  secrets: CredentialStore,
): Effect.Effect<SubscriptionSessionStatus> {
  return getSubscriptionSessionStatus(
    () => codexCoordinator(secrets),
    CHANNEL,
    'ChatGPT',
  );
}

/** The browser sign-in, bound to the registered ChatGPT callback. */
export const codexLoginWithLoopback = defineLoopbackLogin<CodexSession>({
  ports: [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT],
  callbackPath: CODEX_CALLBACK_PATH,
  displayName: 'ChatGPT',
});
