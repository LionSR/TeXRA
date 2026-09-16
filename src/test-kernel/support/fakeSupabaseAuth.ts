/**
 * The shared `SupabaseAuth` fake: a signed-out account plane whose members a
 * suite overrides individually. `client` and `coordinator` raise unless
 * overridden — the probes are what consumers read, and reaching for the
 * sign-in machinery a fake does not have is a test bug worth failing on.
 */
import { Effect } from 'effect';

import type { SupabaseAuthShape } from '@auth/SupabaseAuth';

export function fakeSupabaseAuth(
  overrides: Partial<SupabaseAuthShape> = {},
): SupabaseAuthShape {
  let initError: Error | null = null;
  return {
    get client() {
      if (overrides.client) return overrides.client;
      throw new Error('The fake account plane has no client.');
    },
    get coordinator() {
      if (overrides.coordinator) return overrides.coordinator;
      throw new Error('The fake account plane has no coordinator.');
    },
    isReady: overrides.isReady ?? Effect.succeed(true),
    accessToken: overrides.accessToken ?? Effect.succeed(null),
    user: overrides.user ?? Effect.succeed(null),
    authenticated: overrides.authenticated ?? Effect.succeed(false),
    storedSessionState: overrides.storedSessionState ?? Effect.succeed('none'),
    storedAccountLabel: overrides.storedAccountLabel ?? Effect.succeed(null),
    getInitError: overrides.getInitError ?? (() => initError),
    setInitError:
      overrides.setInitError ??
      ((error) => {
        initError = error;
      }),
  };
}
