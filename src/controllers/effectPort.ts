import { Effect } from 'effect';

/**
 * Call a host port from an Effect program.
 *
 * A port's rejection is the host's own error — a `vscode` API failure, an
 * Electron IPC error, a store's own throw — and the controllers that call one
 * match on that identity. `Effect.tryPromise`'s default catch would wrap it,
 * so every caller wants the identity catch this applies once.
 *
 * The callback may be synchronous or return a promise; a synchronous throw is
 * caught the same way as a rejection. It takes no `AbortSignal`, which is
 * deliberate: a host port has no cancellation to hand it, and
 * `Effect.tryPromise` only creates a signal for a callback that declares one.
 */
export const hostPort = <A>(
  call: () => A | PromiseLike<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: async () => call(), catch: (error) => error });
