/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * The secret-backed storage adapter and singleton coordinator factory live
 * here (with the status + routability probes) so a provider does not re-copy
 * the platform dance.
 */
import * as logger from '@logger/logUtils';
import { tryPlatform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { ProviderAuthErrorCtor } from './providerAuthBridge';
import { SubscriptionOAuthError } from './subscriptionOAuthError';
import type {
  SubscriptionSessionStatus,
  SubscriptionSessionStorage,
} from './SubscriptionOAuthCoordinator';

/** Secret-store slice the session-storage adapter needs. */
export interface SessionSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Session storage over one key of a secret store. */
export function secretBackedSessionStorage(
  secrets: SessionSecretStore,
  key: string,
): SubscriptionSessionStorage {
  return {
    get: () => secrets.get(key),
    store: (value) => secrets.set(key, value),
    delete: () => secrets.delete(key),
  };
}

/**
 * Lazily-built process-wide coordinator backed by a platform secret. `get`
 * throws before platform init; `reset` drops the cached instance (test seam).
 */
export function createSecretBackedCoordinator<C>(init: {
  secretKey: string;
  notInitializedMessage: string;
  makeCoordinator: (storage: SubscriptionSessionStorage) => C;
}): { get(): C; reset(): void } {
  let singleton: C | null = null;
  return {
    get() {
      if (singleton) return singleton;
      const platform = tryPlatform();
      if (!platform) throw new Error(init.notInitializedMessage);
      singleton = init.makeCoordinator(
        secretBackedSessionStorage(platform.secrets, init.secretKey),
      );
      return singleton;
    },
    reset() {
      singleton = null;
    },
  };
}

/** Minimal coordinator surface used for status / routing probes. */
export interface SessionAccessCoordinator {
  getStatus(): Promise<SubscriptionSessionStatus>;
  getFreshAccessToken(): Promise<string>;
  loadSession(): Promise<unknown>;
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
  ErrorType: ProviderAuthErrorCtor,
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
