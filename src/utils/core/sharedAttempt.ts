// Third-party imports
import { Deferred, Effect } from 'effect';

/**
 * Single-flight for an Effect program: concurrent callers of {@link run}
 * share one attempt of the work, and each caller's interruption abandons only
 * its own wait.
 *
 * The work runs on a detached fiber, never on the first caller's. Were it run
 * on the caller's fiber, stopping that caller would interrupt the attempt
 * every joiner is waiting on, and an interrupt landing mid-work (after a
 * provider rotated a single-use refresh token, before it was stored) would
 * drop the result nobody else can recreate. A detached attempt with no caller
 * left still completes, and no caller's interrupt can end it, so the work
 * must carry its own deadline: a stalled attempt holds the slot, and every
 * caller joining it, until the work gives up by itself.
 *
 * The check, the claim and the fork run under one uninterruptible mask and
 * share one synchronous segment, so a second caller can never mint a second
 * attempt and an interrupt can never land between claiming the slot and
 * starting the fiber that settles it.
 */
export class SharedAttempt<A, E> {
  private slot: Deferred.Deferred<A, E> | null = null;

  /** Join the attempt in flight, or start one with `make`. */
  run<R>(make: () => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const existing = this.slot;
        if (existing) return restore(Deferred.await(existing));
        const deferred = Deferred.makeUnsafe<A, E>();
        this.slot = deferred;
        return Effect.flatMap(
          Effect.forkDetach(
            Effect.suspend(make).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (this.slot === deferred) this.slot = null;
                  Deferred.doneUnsafe(deferred, exit);
                }),
              ),
            ),
          ),
          () => restore(Deferred.await(deferred)),
        );
      }),
    );
  }

  /** Whether an attempt is in flight. */
  get inFlight(): boolean {
    return this.slot !== null;
  }

  /**
   * Stop sharing the attempt in flight: the next {@link run} starts a fresh
   * one. Callers already waiting still receive the old attempt's result.
   */
  clear(): void {
    this.slot = null;
  }
}
