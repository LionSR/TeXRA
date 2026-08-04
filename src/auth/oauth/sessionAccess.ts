/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * Codex and Grok each keep a one-line singleton factory; status + routability
 * logic lives here so a third provider does not re-copy the re-auth dance.
 */
import * as logger from '@logger/logUtils';
import { tryPlatform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { SubscriptionOAuthError } from './subscriptionOAuthError';
import type { SubscriptionSessionStatus } from './SubscriptionOAuthCoordinator';

/** Minimal coordinator surface used for status / routing probes. */
export interface SessionAccessCoordinator {
  getStatus(): Promise<SubscriptionSessionStatus>;
  getFreshAccessToken(): Promise<string>;
  loadSession(): Promise<unknown>;
}

export interface SessionAccessNeedsReauthError {
  readonly needsReauth: boolean;
  readonly status?: number;
}

export interface SessionAccessErrorFactory {
  new (
    message: string,
    kind: 'fatal' | 'expired' | 'transient' | 'config' | 'pending',
    status?: number,
    options?: ErrorOptions,
  ): Error & SessionAccessNeedsReauthError;
}

/**
 * Read signed-in status without throwing. Safe before platform init.
 */
export async function getSubscriptionSessionStatus(
  getCoordinator: () => SessionAccessCoordinator,
  channel: string,
  displayName: string,
): Promise<SubscriptionSessionStatus> {
  if (!tryPlatform()) return { signedIn: false };
  try {
    return await getCoordinator().getStatus();
  } catch (error) {
    logger.warn(
      channel,
      `Failed to read ${displayName} session status: ${toErrorMessage(error)}`,
    );
    return { signedIn: false };
  }
}

/**
 * Whether subscription routing should use the stored session. See Codex's
 * `isCodexSessionRoutable` for the re-auth / superseded-session rules.
 */
export async function isSubscriptionSessionRoutable(
  getCoordinator: () => SessionAccessCoordinator,
  ErrorType: SessionAccessErrorFactory,
  displayName: string,
): Promise<boolean> {
  if (!tryPlatform()) return false;
  const coordinator = getCoordinator();
  try {
    await coordinator.getFreshAccessToken();
    return true;
  } catch (error) {
    const authError =
      error instanceof ErrorType || error instanceof SubscriptionOAuthError
        ? error
        : null;
    if (!authError) {
      throw new ErrorType(
        `Could not access ${displayName} session: ${toErrorMessage(error)}`,
        'transient',
        undefined,
        { cause: error },
      );
    }
    if (authError.needsReauth) {
      let storedSession;
      try {
        storedSession = await coordinator.loadSession();
      } catch (readError) {
        throw new ErrorType(
          `Could not verify ${displayName} session: ${toErrorMessage(readError)}`,
          'transient',
          undefined,
          { cause: readError },
        );
      }
      if (storedSession) {
        throw new ErrorType(
          `${displayName} session changed while refreshing.`,
          'transient',
          authError.status,
          { cause: error },
        );
      }
      return false;
    }
    throw error;
  }
}
