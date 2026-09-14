/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * The secret-backed storage adapter and singleton coordinator factory live
 * here (with the status probe) so a provider does not re-copy the platform
 * dance.
 */
import { runAuthProgram } from '@auth/authProgram';
import { createLog } from '@logger/logUtils';
import type { SecretsFailed } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { Effect } from 'effect';

import type {
  SubscriptionSessionStatus,
  SubscriptionSessionStorage,
} from './SubscriptionOAuthCoordinator';

/** Secret-store slice the session-storage adapter needs. */
export interface SessionSecretStore {
  get(key: string): Effect.Effect<string | undefined, SecretsFailed>;
  set(key: string, value: string): Effect.Effect<void, SecretsFailed>;
  delete(key: string): Effect.Effect<void, SecretsFailed>;
}

/**
 * Session storage over one key of a secret store.
 * {@link SubscriptionSessionStorage} is the coordinator's Promise-shaped
 * surface, so every one of the store's programs settles on the auth
 * subsystem's installed run edge, which re-throws the {@link SecretsFailed}
 * unchanged.
 */
export function secretBackedSessionStorage(
  secrets: SessionSecretStore,
  key: string,
): SubscriptionSessionStorage {
  return {
    get: () => runAuthProgram(secrets.get(key)),
    store: (value) => runAuthProgram(secrets.set(key, value)),
    delete: () => runAuthProgram(secrets.delete(key)),
  };
}

/**
 * Lazily-built process-wide coordinator over one key of the secret store its
 * caller holds. There is one such coordinator per process on purpose: it
 * carries the in-flight refresh and the serialized session writes, and two
 * instances over the same secret would race a rotating refresh token. The
 * process store reaches callers under two identities (the raw host store and
 * the `Secrets` service that forwards to it), so the first `get` fixes the
 * instance and later calls do not compare store identity. `reset` drops it
 * (test seam; a test that swaps the host store must reset first).
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
