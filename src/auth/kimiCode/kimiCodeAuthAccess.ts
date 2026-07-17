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

/** Signed-in status, safe to call before platform init (returns signed-out). */
async function getKimiCodeStatus(): Promise<KimiCodeSessionStatus> {
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
