import { Cause, Effect, Latch, Queue, type Scope } from 'effect';
import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'cli.chat';

/**
 * The chat session's follow-up deliveries: one at a time, in the order they
 * were submitted.
 *
 * Each behaviour the call sites rely on is held by one structure:
 *
 * - **One at a time, FIFO.** An unbounded `Queue` drained by a single fiber
 *   that runs each delivery to completion before it takes the next. The
 *   drain is the lane: there is no permit apart from the running delivery,
 *   so nothing can hand the lane on while a delivery is still running.
 * - **`clear` drops only what has not started.** It takes whatever is still
 *   buffered; a delivery the drain has already taken keeps running.
 * - **`idle` waits for the running delivery and everything behind it.** A
 *   count of unsettled deliveries, raised on `enqueue` and lowered when a
 *   delivery settles or `clear` drops it, keeps a `Latch` open exactly while
 *   the count is zero.
 * - **A delivery cannot fail.** Its type admits no error, so the caller
 *   attaches recovery before the delivery enters the queue. A defect (a
 *   throw from the body) is logged at the drain and the worker continues;
 *   an interruption is the scope closing and stops the drain.
 *
 * A `Semaphore` with a `FiberSet` of forked deliveries was the alternative,
 * and it does not fit: a semaphore cannot drop its waiters, so `clear` would
 * need a second record of which fibers are still waiting in order to
 * interrupt them.
 *
 * `enqueue` and `clear` are synchronous because their callers are the
 * controller's Promise-shaped commands, which must drop or queue in the step
 * that decides to.
 */
export interface FollowUpDeliveryQueue {
  /** Queue a delivery behind every earlier one that has not settled. */
  readonly enqueue: (delivery: Effect.Effect<void>) => void;
  /** Drop the deliveries that have not started; the running one finishes. */
  readonly clear: () => void;
  /** Succeeds once no delivery is running or queued. */
  readonly idle: Effect.Effect<void>;
}

/** Open a {@link FollowUpDeliveryQueue} whose drain `scope` owns. */
export const makeFollowUpDeliveryQueue = (
  scope: Scope.Scope,
): Effect.Effect<FollowUpDeliveryQueue> =>
  Effect.gen(function* () {
    const deliveries = yield* Queue.unbounded<Effect.Effect<void>>();
    const idle = yield* Latch.make(true);
    let unsettled = 0;
    const settle = (count: number): void => {
      unsettled -= count;
      if (unsettled === 0) idle.openUnsafe();
    };
    // The settle finalizer is attached in the same uninterruptible step that
    // takes the delivery, so a drain interrupted by the scope's close cannot
    // lose a taken delivery's count.
    yield* Effect.uninterruptibleMask((restore) =>
      restore(Queue.take(deliveries)).pipe(
        Effect.flatMap((delivery) =>
          Effect.ensuring(
            restore(delivery).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning(
                      `A follow-up delivery failed: ${toErrorMessage(Cause.squash(cause))}`,
                    ).pipe(withLogChannel(CHANNEL)),
              ),
            ),
            Effect.sync(() => settle(1)),
          ),
        ),
      ),
    ).pipe(Effect.forever, Effect.forkIn(scope));
    return {
      enqueue: (delivery) => {
        unsettled += 1;
        idle.closeUnsafe();
        Queue.offerUnsafe(deliveries, delivery);
      },
      clear: () => {
        let dropped = 0;
        while (Queue.takeUnsafe(deliveries) !== undefined) dropped += 1;
        if (dropped > 0) settle(dropped);
      },
      idle: idle.await,
    };
  });
