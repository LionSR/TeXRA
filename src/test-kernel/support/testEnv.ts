import { ConfigProvider, Effect } from 'effect';

/**
 * Serve `env` as the process environment to one program. A converted reader
 * (`envVar`/`envFlag`) run outside the harness runtime must be given an
 * explicit provider; the ambient default is a one-time copy of the
 * developer's shell and ignores `vi.stubEnv`.
 */
export const withEnv =
  (env: Record<string, string>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(
      self,
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(env),
    );
