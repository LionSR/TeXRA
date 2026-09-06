/**
 * The Promise edge of the auth subsystem's Effect programs (Effect 4 runtime
 * PRD, R1 and R7): one run boundary behind each Promise-facing method, and
 * one typed failure for the host ports those programs call.
 */
import { Cause, Data, Deferred, Effect, Exit, Option, Semaphore } from 'effect';

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
 * Serialized storage writes with an idle barrier — what a coordinator's
 * `p-queue` serializer was: one write at a time, and a reader can wait for
 * every write queued before it. A single-permit semaphore alone cannot give
 * the barrier: it frees its permit before it wakes its waiters, so a fiber
 * that just released it and asks again barges ahead of a queued write. The
 * barrier therefore counts queued writes itself and waits on a `Deferred`
 * the last one settles; it depends on no scheduler wake ordering.
 */
export class SerializedWrites {
  private readonly permit = Semaphore.makeUnsafe(1);
  private queued = 0;
  private idle: Deferred.Deferred<void> | null = null;

  /**
   * Queue `write` behind the permit. `onQueue` runs in the same synchronous
   * segment that counts the write as queued — before any fiber boundary — so
   * a caller can publish that a write is coming (bump a generation) atomically
   * with queueing it, as a synchronous `queue.add()` used to.
   */
  run<A, E>(
    write: Effect.Effect<A, E>,
    onQueue?: () => void,
  ): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      onQueue?.();
      this.queued += 1;
      return this.permit
        .withPermits(1)(write)
        .pipe(Effect.ensuring(Effect.sync(() => this.dequeue())));
    });
  }

  private dequeue(): void {
    this.queued -= 1;
    if (this.queued === 0 && this.idle) {
      const idle = this.idle;
      this.idle = null;
      Deferred.doneUnsafe(idle, Effect.void);
    }
  }

  /** Wait until every write queued before this call has run. */
  readonly awaitIdle = Effect.fn('SerializedWrites.awaitIdle')(function* (
    this: SerializedWrites,
  ) {
    while (this.queued > 0) {
      this.idle ??= Deferred.makeUnsafe<void>();
      yield* Deferred.await(this.idle);
    }
  });
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
