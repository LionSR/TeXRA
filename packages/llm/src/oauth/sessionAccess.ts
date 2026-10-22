/**
 * Shared platform-backed access helpers for subscription OAuth coordinators.
 *
 * The secret-backed session storage and singleton coordinator factory live
 * here so a provider does not re-copy the platform dance.
 */
import type { CredentialStore } from '../providers/credentials.js';

import type { SubscriptionSessionStorage } from './SubscriptionOAuthCoordinator.js';

/** Session storage over one key of a secret store. */
function secretBackedSessionStorage(
  secrets: CredentialStore,
  key: string,
): SubscriptionSessionStorage {
  return {
    get: () => secrets.get(key),
    store: (value) => secrets.set(key, value),
    delete: () => secrets.delete(key),
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
export function createSecretBackedCoordinator<C extends object>(init: {
  secretKey: string;
  makeCoordinator: (storage: SubscriptionSessionStorage) => C;
}): (secrets: CredentialStore) => C {
  const coordinators = new WeakMap<CredentialStore, C>();
  return (secrets) => {
    const existing = coordinators.get(secrets);
    if (existing) return existing;
    const coordinator = init.makeCoordinator(
      secretBackedSessionStorage(secrets, init.secretKey),
    );
    coordinators.set(secrets, coordinator);
    return coordinator;
  };
}
