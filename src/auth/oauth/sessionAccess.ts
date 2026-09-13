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
 * instance; `reset` drops it (test seam).
 */
export function createSecretBackedCoordinator<C>(init: {
  secretKey: string;
  makeCoordinator: (storage: SubscriptionSessionStorage) => C;
}): { get(secrets: SessionSecretStore): C; reset(): void } {
  let singleton: C | null = null;
  return {
    get(secrets) {
      singleton ??= init.makeCoordinator(
        secretBackedSessionStorage(secrets, init.secretKey),
      );
      return singleton;
    },
    reset() {
      singleton = null;
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
