/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * The secret-backed session storage and singleton coordinator factory live
 * here (with the status probe) so a provider does not re-copy the platform
 * dance.
 */
import { Effect } from 'effect';
import { AuthPortError, settleFailure } from '@auth/authProgram';
import { withLogChannel } from '@logger/effectLog';
import type { SecretsFailed } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type {
  SubscriptionSessionStatus,
  SubscriptionSessionStorage,
} from './SubscriptionOAuthCoordinator';

/** Secret-store slice the session storage needs. */
export interface SessionSecretStore {
  get(key: string): Effect.Effect<string | undefined, SecretsFailed>;
  set(key: string, value: string): Effect.Effect<void, SecretsFailed>;
  delete(key: string): Effect.Effect<void, SecretsFailed>;
}

/**
 * Session storage over one key of a secret store. The store's
 * {@link SecretsFailed} travels as {@link AuthPortError} — the failure shape
 * the coordinators match on for any port rejection.
 */
export function secretBackedSessionStorage(
  secrets: SessionSecretStore,
  key: string,
): SubscriptionSessionStorage {
  const toPortError = (cause: SecretsFailed) => new AuthPortError({ cause });
  return {
    get: () => secrets.get(key).pipe(Effect.mapError(toPortError)),
    store: (value) =>
      secrets.set(key, value).pipe(Effect.mapError(toPortError)),
    delete: () => secrets.delete(key).pipe(Effect.mapError(toPortError)),
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
    if (coordinators.has(secrets)) {
      // `has` proved the entry, and only this closure writes the map.
      return coordinators.get(secrets) as C;
    }
    const coordinator = init.makeCoordinator(
      secretBackedSessionStorage(secrets, init.secretKey),
    );
    coordinators.set(secrets, coordinator);
    return coordinator;
  };
}

/** Minimal coordinator surface used for the status probe. */
export interface SessionAccessCoordinator {
  getStatus(): Effect.Effect<SubscriptionSessionStatus, Error>;
}

/**
 * Read signed-in status without failing: a store the caller could not open
 * reports signed-out, with the cause logged. The probe's recovery is part of
 * the program; the caller yields it or settles it at its own edge.
 */
export function getSubscriptionSessionStatus(
  getCoordinator: () => SessionAccessCoordinator,
  channel: string,
  displayName: string,
): Effect.Effect<SubscriptionSessionStatus> {
  return Effect.suspend(() => getCoordinator().getStatus()).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `Failed to read ${displayName} session status: ${toErrorMessage(settleFailure(cause))}`,
      ).pipe(withLogChannel(channel), Effect.as({ signedIn: false })),
    ),
  );
}
