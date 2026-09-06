/**
 * The Promise edge of the auth subsystem's Effect programs (Effect 4 runtime
 * PRD, R1 and R7): one run boundary behind each Promise-facing method, and
 * one typed failure for the host ports those programs call.
 */
import { Cause, Data, Effect, Exit, Option, type Semaphore } from 'effect';

import { effectRuntime } from '@platform/processRuntime';

/**
 * A host port (secret storage), an SDK call, or a provider policy rejected.
 * `cause` is that caller's own error; the Promise edge re-throws it
 * unchanged, so every `instanceof` and message check a host makes still
 * holds.
 */
export class AuthPortError extends Data.TaggedError('AuthPortError')<{
  readonly cause: unknown;
}> {}

/** Adapt one Promise port call; its rejection becomes an {@link AuthPortError}. */
export function callPort<A>(
  call: () => Promise<A>,
): Effect.Effect<A, AuthPortError> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => new AuthPortError({ cause }),
  });
}

/**
 * Wait until every write queued ahead of us on a single-permit semaphore has
 * run — the barrier a stable read takes before loading. The permit is freed
 * before its waiters are woken, so a fiber that just released it and asks
 * again would barge ahead of them; yielding first lets the woken writer take
 * the permit, and this take then queues behind it.
 */
export function awaitWritesAhead(
  writes: Semaphore.Semaphore,
): Effect.Effect<void> {
  return Effect.andThen(Effect.yieldNow, writes.withPermits(1)(Effect.void));
}

function rethrowPortCause(error: unknown): never {
  throw error instanceof AuthPortError ? error.cause : error;
}

/**
 * Run one auth program on the process runtime and settle it as a Promise.
 * An expected failure reaches `rethrow`, which re-mints it as the error the
 * caller matches on — by default the port's own error, unwrapped. Defects
 * and interruption propagate as they are.
 */
export async function runAuthProgram<A, E>(
  program: Effect.Effect<A, E>,
  rethrow: (error: E) => never = rethrowPortCause,
): Promise<A> {
  const exit = await effectRuntime().runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) return rethrow(failure.value);
  throw Cause.squash(exit.cause);
}
