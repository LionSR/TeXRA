/**
 * Access to the Codex OAuth coordinator, over the secret store its caller
 * holds: one coordinator per store instance, so distinct stores never share
 * session state.
 */
import { Effect, Result } from 'effect';

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

const coordinatorFor = createSecretBackedCoordinator({
  secretKey: CODEX_SESSION_SECRET_KEY,
  makeCoordinator: (storage) => new CodexSessionCoordinator({ storage }),
});

/** The coordinator for the caller's secret store. */
export function codexCoordinator(
  secrets: SessionSecretStore,
): CodexSessionCoordinator {
  return coordinatorFor(secrets);
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
 * Runs one host read inside the caller's frame. The routability check reads
 * the secret store and the network through the caller's workspace-roots
 * frame, so the frame is applied around each host call rather than around
 * the construction of the program.
 */
type HostReadScope = <T>(read: () => T) => T;

/**
 * Whether subscription routing should use the stored session. A refresh that
 * fails with a re-auth error is only routable-false when the stored session is
 * gone; if a session is still there, another writer replaced it mid-refresh,
 * which is transient.
 */
export const isCodexSessionRoutable = Effect.fn('codexAuth.isSessionRoutable')(
  function* (secrets: SessionSecretStore, inScope: HostReadScope) {
    const coordinator = codexCoordinator(secrets);
    const refreshed = yield* Effect.result(
      Effect.tryPromise({
        try: () => inScope(() => coordinator.getFreshAccessToken()),
        catch: (error) =>
          error instanceof SubscriptionOAuthError
            ? error
            : new CodexAuthError(
                `Could not access ChatGPT session: ${toErrorMessage(error)}`,
                'transient',
                undefined,
                { cause: error },
              ),
      }),
    );
    if (Result.isSuccess(refreshed)) return true;
    const error = refreshed.failure;
    if (!error.needsReauth) return yield* Effect.fail(error);
    const storedSession = yield* Effect.tryPromise({
      try: () => inScope(() => coordinator.loadSession()),
      catch: (readError) =>
        new CodexAuthError(
          `Could not verify ChatGPT session: ${toErrorMessage(readError)}`,
          'transient',
          undefined,
          { cause: readError },
        ),
    });
    if (storedSession) {
      return yield* Effect.fail(
        new CodexAuthError(
          'ChatGPT session changed while refreshing.',
          'transient',
          error.status,
          { cause: error },
        ),
      );
    }
    return false;
  },
);
