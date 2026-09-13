/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * The secret-backed storage adapter and singleton coordinator factory live
 * here (with the status probe) so a provider does not re-copy the platform
 * dance.
 */
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
 * Lazily-built process-wide coordinator over one key of the secret store its
 * caller holds. The store is process-wide, so the first `get` fixes the
 * instance and every later `get` must pass that same store: a different one
 * is a wiring error and throws rather than silently answering from the
 * first. `reset` drops the instance (test seam).
 */
export function createSecretBackedCoordinator<C>(init: {
  secretKey: string;
  makeCoordinator: (storage: SubscriptionSessionStorage) => C;
}): { get(secrets: SessionSecretStore): C; reset(): void } {
  let materialized: { secrets: SessionSecretStore; coordinator: C } | null =
    null;
  return {
    get(secrets) {
      if (materialized === null) {
        materialized = {
          secrets,
          coordinator: init.makeCoordinator(
            secretBackedSessionStorage(secrets, init.secretKey),
          ),
        };
      } else if (materialized.secrets !== secrets) {
        throw new Error(
          `The ${init.secretKey} coordinator was built over a different secret store; reset it before switching stores.`,
        );
      }
      return materialized.coordinator;
    },
    reset() {
      materialized = null;
    },
  };
}

/** Minimal coordinator surface used for the status probe. */
export interface SessionAccessCoordinator {
  getStatus(): Promise<SubscriptionSessionStatus>;
}

/**
 * Read signed-in status without throwing: a store the caller could not open
 * reports signed-out, with the cause logged.
 */
export async function getSubscriptionSessionStatus(
  getCoordinator: () => SessionAccessCoordinator,
  channel: string,
  displayName: string,
): Promise<SubscriptionSessionStatus> {
  try {
    return await getCoordinator().getStatus();
  } catch (error) {
    createLog(channel).warn(
      `Failed to read ${displayName} session status: ${toErrorMessage(error)}`,
    );
    return { signedIn: false };
  }
}
