import { Effect } from 'effect';

/**
 * Call a host port from an Effect program.
 *
 * A port's rejection is the host's own error — a `vscode` API failure, an
 * Electron IPC error, a GitHub client's throw, a store's own throw — and the
 * caller that matches on it wants that identity, not a wrapper.
 * `Effect.tryPromise`'s default catch would wrap it, so the identity catch is
 * applied here once instead of at each boundary. Five copies of this had
 * accumulated across `src/tools`, the CLI, and the extension; it lives in
 * `common` so every layer that already depends on `common` can reach the one.
 *
 * The callback may be synchronous or return a promise: `Effect.tryPromise`
 * catches a synchronous throw from `try` itself, and the `async` wrapper is
 * what lets a callback return a plain `A`. It takes no `AbortSignal`, which
 * is deliberate: a host port has no cancellation to hand it, and
 * `Effect.tryPromise` only creates a signal for a callback that declares one.
 */
export const hostPort = <A>(
  call: () => A | PromiseLike<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: async () => call(), catch: (error) => error });
