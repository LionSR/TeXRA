/**
 * Process-wide access to the Codex OAuth coordinator, backed by
 * `platform().secrets`.
 */
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
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

/**
 * The shared coordinator. Throws if the platform has not been initialized yet
 * (callers run after `initPlatform()`).
 */
export function codexCoordinator(): CodexSessionCoordinator {
  return coordinatorAccess.get();
}

/** Test seam: drop the cached coordinator. */
export function resetCodexCoordinator(): void {
  coordinatorAccess.reset();
}

/** Signed-in status. Call only after the host initializes the platform. */
export async function getCodexStatus(): Promise<CodexSessionStatus> {
  return getSubscriptionSessionStatus(codexCoordinator, CHANNEL, 'ChatGPT');
}

/**
 * Whether subscription routing should use the stored session. A refresh that
 * fails with a re-auth error is only routable-false when the stored session is
 * gone; if a session is still there, another writer replaced it mid-refresh,
 * which is transient.
 */
export async function isCodexSessionRoutable(): Promise<boolean> {
  const coordinator = codexCoordinator();
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
