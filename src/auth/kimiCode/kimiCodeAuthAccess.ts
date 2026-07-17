/**
 * Process-wide access to the Kimi Code OAuth coordinator, backed by
 * `platform().secrets`. The model handler, availability gate, and login
 * commands all share one instance so its single-flight refresh state is
 * honored within a process.
 *
 * Stays `vscode`-free: reaches the keychain only through the platform port.
 */
import { tryPlatform } from '@platform/platform';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { createKimiCodeAuthCoordinator } from './KimiCodeAuthCoordinator';
import {
  type KimiCodeSessionCoordinator,
  type KimiCodeSessionStatus,
} from './KimiCodeSessionCoordinator';
import { KimiCodeAuthError } from './kimiCodeSessionTypes';
import {
  isKimiCodeSubscriptionToolUseOnly,
  isPreferKimiCodeSubscription,
} from './kimiCodePreference';

const CHANNEL = 'kimiCodeAuth';

let singleton: KimiCodeSessionCoordinator | null = null;

/**
 * The shared coordinator. Throws if the platform has not been initialized yet
 * (callers run after `initPlatform()`).
 */
export function kimiCodeCoordinator(): KimiCodeSessionCoordinator {
  if (singleton) return singleton;
  const platform = tryPlatform();
  if (!platform) {
    throw new Error('Kimi Code auth used before the platform was initialized.');
  }
  singleton = createKimiCodeAuthCoordinator({ secrets: platform.secrets });
  return singleton;
}

/** Test seam: drop the cached coordinator. */
export function resetKimiCodeCoordinator(): void {
  singleton = null;
}

/** Signed-in status, safe to call before platform init (returns signed-out). */
export async function getKimiCodeStatus(): Promise<KimiCodeSessionStatus> {
  if (!tryPlatform()) return { signedIn: false };
  try {
    return await kimiCodeCoordinator().getStatus();
  } catch (error) {
    // Treat an unreadable session as signed-out, but surface the unexpected
    // failure (corrupted keychain entry, platform misconfig) for diagnosis.
    logger.warn(
      CHANNEL,
      `Failed to read Kimi Code session status: ${toErrorMessage(error)}`,
    );
    return { signedIn: false };
  }
}

/** Whether a Kimi Code session is currently signed in (no network, no throw). */
export async function isKimiCodeSignedIn(): Promise<boolean> {
  return (await getKimiCodeStatus()).signedIn;
}

/**
 * Whether subscription routing should use the stored session. Expiring
 * sessions are refreshed by the coordinator; absent/dead sessions return false
 * after its re-auth path clears them. If a re-auth error leaves a session in
 * storage, the refresh was superseded and the error propagates rather than
 * misrouting the newer session. Retryable errors likewise propagate so callers
 * do not silently spend fallback quota or immediately retry the same refresh.
 */
export async function isKimiCodeSessionRoutable(): Promise<boolean> {
  if (!tryPlatform()) return false;
  const coordinator = kimiCodeCoordinator();
  try {
    await coordinator.getFreshAccessToken();
    return true;
  } catch (error) {
    if (!(error instanceof KimiCodeAuthError)) {
      throw new KimiCodeAuthError(
        `Could not access Kimi Code session: ${toErrorMessage(error)}`,
        'transient',
        undefined,
        { cause: error },
      );
    }
    if (error.needsReauth) {
      let storedSession;
      try {
        storedSession = await coordinator.loadSession();
      } catch (readError) {
        throw new KimiCodeAuthError(
          `Could not verify Kimi Code session: ${toErrorMessage(readError)}`,
          'transient',
          undefined,
          { cause: readError },
        );
      }
      if (storedSession) {
        throw new KimiCodeAuthError(
          'Kimi Code session changed while refreshing.',
          'transient',
          error.status,
          { cause: error },
        );
      }
      return false;
    }
    throw error;
  }
}

/**
 * The Kimi Code auth status as the settings views consume it: the session
 * status plus the current subscription preferences. One composer so the
 * extension and desktop hosts post the identical payload.
 */
export async function getKimiCodeAuthStatus(): Promise<
  KimiCodeSessionStatus & {
    preferSubscription: boolean;
    subscriptionToolUseOnly: boolean;
  }
> {
  return {
    ...(await getKimiCodeStatus()),
    preferSubscription: isPreferKimiCodeSubscription(),
    subscriptionToolUseOnly: isKimiCodeSubscriptionToolUseOnly(),
  };
}
