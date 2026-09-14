/**
 * Process-wide access to the Codex OAuth coordinator, over the secret store
 * its caller holds.
 */
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
  type SessionSecretStore,
} from '../oauth/sessionAccess';
import { SubscriptionOAuthError } from '../oauth/subscriptionOAuthError';
import { CODEX_SESSION_SECRET_KEY } from './codexConstants';
import {
  CodexSessionCoordinator,
  type CodexSessionStatus,
} from './CodexSessionCoordinator';
import { CodexAuthError } from './codexSessionTypes';

const CHANNEL = 'codexAuth';

const coordinatorAccess = createSecretBackedCoordinator({
  secretKey: CODEX_SESSION_SECRET_KEY,
  makeCoordinator: (storage) => new CodexSessionCoordinator({ storage }),
});

/** The shared coordinator, over the caller's secret store. */
export function codexCoordinator(
  secrets: SessionSecretStore,
): CodexSessionCoordinator {
  return coordinatorAccess.get(secrets);
}

/** Test seam: drop the cached coordinator. */
export function resetCodexCoordinator(): void {
  coordinatorAccess.reset();
}

/** Signed-in status, read from the caller's secret store. */
export async function getCodexStatus(
  secrets: SessionSecretStore,
): Promise<CodexSessionStatus> {
  return getSubscriptionSessionStatus(
    () => codexCoordinator(secrets),
    CHANNEL,
    'ChatGPT',
  );
}

/**
 * Whether subscription routing should use the stored session. A refresh that
 * fails with a re-auth error is only routable-false when the stored session is
 * gone; if a session is still there, another writer replaced it mid-refresh,
 * which is transient.
 */
export async function isCodexSessionRoutable(
  secrets: SessionSecretStore,
): Promise<boolean> {
  const coordinator = codexCoordinator(secrets);
  try {
    await coordinator.getFreshAccessToken();
    return true;
  } catch (error) {
    if (!(error instanceof SubscriptionOAuthError)) {
      throw new CodexAuthError(
        `Could not access ChatGPT session: ${toErrorMessage(error)}`,
        'transient',
        undefined,
        { cause: error },
      );
    }
    if (!error.needsReauth) throw error;
    let storedSession;
    try {
      storedSession = await coordinator.loadSession();
    } catch (readError) {
      throw new CodexAuthError(
        `Could not verify ChatGPT session: ${toErrorMessage(readError)}`,
        'transient',
        undefined,
        { cause: readError },
      );
    }
    if (storedSession) {
      throw new CodexAuthError(
        'ChatGPT session changed while refreshing.',
        'transient',
        error.status,
        { cause: error },
      );
    }
    return false;
  }
}
