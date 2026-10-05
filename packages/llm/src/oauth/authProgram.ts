/**
 * The typed failure of the auth subsystem's Effect programs (Effect 4 runtime
 * PRD, R1 and R7): one error for the host ports those programs call, the
 * serialized-write lane the coordinators share, and the settle-fold a host
 * boundary applies when it runs one of those programs on its own runtime.
 * Nothing here runs an Effect: a host entry runs the program it composes.
 */
import { Cause, Data, Deferred, Effect, Option, Semaphore } from 'effect';

/**
 * A host port (secret storage), an SDK call, or a provider policy rejected.
 * `cause` is that caller's own error; the Promise edge re-throws it
 * unchanged, so every `instanceof` and message check a host makes still
 * holds.
 */
export class AuthPortError extends Data.TaggedError('AuthPortError')<{
  readonly cause: unknown;
}> {}

/**
 * Serialized storage writes with an idle barrier — what a coordinator's
 * `p-queue` serializer was: one write at a time, a write that holds the
 * permit runs to completion, and a reader can wait for every write queued
 * before it. A single-permit semaphore alone cannot give the barrier: it
 * frees its permit before it wakes its waiters, so a fiber that just
 * released it and asks again barges ahead of a queued write. The barrier
 * therefore counts queued writes itself and waits on a `Deferred` the last
 * one settles; it depends on no scheduler wake ordering.
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
      // Interruption is observed while waiting for the permit, never once it
      // is held. A port write cannot be cancelled — `callPort` never aborts
      // the Promise it wraps — so an interruptible write would release the
      // permit and leave the barrier idle while the storage write is still
      // pending, and the next write would run beside it. The p-queue job it
      // replaces always finished, with later jobs queued behind it.
      return this.permit
        .withPermits(1)(Effect.uninterruptible(write))
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

// Preserve the port's original rejection value: minting an `Error` from a
// non-`Error` cause would break its identity.
const settleExpected = (error: unknown): unknown =>
  error instanceof AuthPortError ? error.cause : error;

/**
 * The value a Promise-facing boundary throws for `cause`: an expected
 * {@link AuthPortError} re-mints as the port's own rejection, another
 * expected failure stays itself, and a defect or an interruption squashes. A
 * recovery that settles a program inside `Effect.catchCause` classifies the
 * failure through this same fold, so the unwrap rule lives in exactly one
 * place.
 */
export function settleFailure<E>(cause: Cause.Cause<E>): unknown {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) return settleExpected(failure.value);
  return Cause.squash(cause);
}
