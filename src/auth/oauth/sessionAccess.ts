/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * The secret-backed storage adapter and singleton coordinator factory live
 * here (with the status probe) so a provider does not re-copy the platform
 * dance.
 */
import { Effect } from 'effect';
import { callPort, runAuthProgram, settleFailure } from '@auth/authProgram';
import { createLog } from '@logger/logUtils';
import type { SecretsFailed } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
 * Lazily-built coordinator over one key of the secret store it is handed. The
 * coordinator carries the in-flight refresh and the serialized session writes,
 * and two instances over the same secret would race a rotating refresh token,
 * so reuse is keyed by the store instance itself: one store, one coordinator.
 * Every host root opens exactly one store per process and hands that same value
 * to the runtime, to the account probes and to the surfaces above them, so a
 * process holds one coordinator per provider. A store that is replaced (a test
 * that reinstalls its host) gets a coordinator of its own instead of the
 * previous store's, which is why no reset seam exists.
 */
export function createSecretBackedCoordinator<C>(init: {
  secretKey: string;
  makeCoordinator: (storage: SubscriptionSessionStorage) => C;
}): (secrets: SessionSecretStore) => C {
  const coordinators = new WeakMap<SessionSecretStore, C>();
  return (secrets) => {
    const existing = coordinators.get(secrets);
    if (existing !== undefined) return existing;
    const coordinator = init.makeCoordinator(
      secretBackedSessionStorage(secrets, init.secretKey),
    );
    coordinators.set(secrets, coordinator);
    return coordinator;
  };
}

/** Minimal coordinator surface used for the status probe. */
export interface SessionAccessCoordinator {
  getStatus(): Promise<SubscriptionSessionStatus>;
}

/**
 * Read signed-in status without throwing: a store the caller could not open
 * reports signed-out, with the cause logged. The probe's recovery is part of
 * the program; only its settled answer crosses the Promise surface, on the
 * auth subsystem's installed run edge.
 */
export function getSubscriptionSessionStatus(
  getCoordinator: () => SessionAccessCoordinator,
  channel: string,
  displayName: string,
): Promise<SubscriptionSessionStatus> {
  return runAuthProgram(
    callPort(() => getCoordinator().getStatus()).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          createLog(channel).warn(
            `Failed to read ${displayName} session status: ${toErrorMessage(settleFailure(cause))}`,
          );
          return { signedIn: false };
        }),
      ),
    ),
  );
}
