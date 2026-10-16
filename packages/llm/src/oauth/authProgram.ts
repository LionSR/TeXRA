/**
 * The serialized-write lane the subscription OAuth coordinators share. Nothing
 * here runs an Effect: a host entry runs the program it composes.
 */
import { Deferred, Effect, Semaphore } from 'effect';

/**
 * Serialized storage writes with an idle barrier: one write at a time, a
 * write that holds the permit runs to completion, and a reader can wait for
 * every write queued before it. A single-permit semaphore alone cannot give
 * the barrier: it frees its permit before it wakes its waiters, so a fiber
 * that just released it and asks again barges ahead of a queued write. The
 * barrier therefore counts queued writes itself and waits on a `Deferred` the
 * last one settles; it depends on no scheduler wake ordering.
 */
export class SerializedWrites {
  private readonly permit = Semaphore.makeUnsafe(1);
  private queued = 0;
  private idle: Deferred.Deferred<void> | null = null;

  /**
   * Queue `write` behind the permit. `onQueue` runs in the same synchronous
   * segment that counts the write as queued — before any fiber boundary — so
   * a caller can publish that a write is coming (bump a generation) atomically
   * with queueing it.
   */
  run<A, E>(
    write: Effect.Effect<A, E>,
    onQueue?: () => void,
  ): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      onQueue?.();
      this.queued += 1;
      // Interruption is observed while waiting for the permit, never once it
      // is held. A storage write cannot be cancelled once the store has it,
      // so an interruptible write would release the permit and leave the
      // barrier idle while the write is still pending, and the next write
      // would run beside it.
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
