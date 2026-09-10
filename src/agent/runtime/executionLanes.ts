/**
 * Lane scheduling for execution lifecycles.
 *
 * Owns the per-execution serial lanes that `ExecutionRegistry` runs lifecycle
 * steps through, so launch, resume, and delete of one execution id never
 * overlap while unrelated executions proceed in parallel.
 *
 * A lane is a `Deferred` hand-off chain, not a queue: each entrant swaps its
 * own `Deferred` in as the lane's tail synchronously when its effect starts,
 * waits for its predecessor's, and completes its own in its release
 * finalizer. That gives FIFO admission for free and makes the whole wait
 * interruptible — a caller whose fiber is interrupted while queued hands its
 * successor the wait for whoever actually holds the lane, instead of leaving a
 * task behind in a queue nobody can reach. It is the same shape as
 * `withPerKeyLane` (`@utils/core/perKeyQueue`), with the two facts this
 * scheduler adds on top: the generation gate (`live`) and refusal at session
 * disposal.
 */

import { Data, Deferred, Effect } from 'effect';

/** A local generation or its retained handle still owns the execution. */
export class ExecutionBusy extends Data.TaggedError('ExecutionBusy')<{
  readonly executionId: string;
}> {}

/**
 * The serial lifecycle lane of one execution id. Launch, resume, delete and
 * any other lifecycle step run through the `tail` chain one at a time, and
 * each step first waits for every generation in `live` — the ones the last
 * launches started — to dispose. Generations of one execution therefore never
 * coexist: a resume cannot mint a lease while the previous run still holds
 * one, and a delete cannot run under a live run. Stop is a signal to the live
 * generation, not a step.
 */
interface ExecutionLane {
  /**
   * What the next entrant waits for: the `Deferred` the most recent one
   * completes as it leaves. `undefined` on a lane no step has claimed yet.
   */
  tail: Deferred.Deferred<void> | undefined;
  /** Fibers holding or waiting on the lane; at zero the lane can be forgotten. */
  fibers: number;
  /**
   * The completion of every generation still unwinding — held as a set rather
   * than one chained value because they end in no fixed order: a turn's
   * teardown routinely ends while the child loop that outlives it is still
   * live, and clearing the gate on the shorter one would let a resume claim
   * the execution under the loop still holding it.
   */
  readonly live: Set<Deferred.Deferred<void>>;
  /** Steps admitted but not yet started; failed if the session disposes. */
  readonly waiting: Set<Deferred.Deferred<never, Error>>;
}

/**
 * The per-execution lanes of one session's registry. A lane is created on
 * first use and forgotten once it drains, so idle executions hold no lane.
 */
export class ExecutionLanes {
  private readonly lanes = new Map<string, ExecutionLane>();

  /** Acquire an idle execution slot, refusing competing local ownership. */
  withInactiveStep<A, E, R>(
    executionId: string,
    hasRetainedOwner: () => boolean,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return this.onLane(executionId, operation, hasRetainedOwner);
  }

  /** Hold a generation's lane until its Effect and finalizers settle. */
  launch<A, E, R>(
    executionId: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return this.onLane(executionId, operation);
  }

  /**
   * Add `termination` to the lane's live generations.
   *
   * The teardown releases the execution lease: it is the tail of the
   * suspended generation, so the lane waits for it before a resume can
   * claim the execution again.
   * A child loop's generation stays in the gate until the loop ends; a
   * turn's teardown joins it rather than replacing it, and the gate opens
   * only once every one of them has unwound.
   */
  holdLive(
    executionId: string,
    termination: Effect.Effect<void>,
  ): Effect.Effect<void> {
    const completion = Deferred.makeUnsafe<void>();
    const lane = this.laneFor(executionId);
    lane.live.add(completion);
    return termination.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Deferred.doneUnsafe(completion, Effect.void);
          lane.live.delete(completion);
          this.forgetIdleLane(executionId, lane);
        }),
      ),
      Effect.uninterruptible,
    );
  }

  /** Refuse every admitted-but-unstarted step and drop all lanes. */
  disposeAll(error: Error): void {
    for (const lane of this.lanes.values()) {
      for (const refusal of lane.waiting) {
        Deferred.doneUnsafe(refusal, Effect.fail(error));
      }
      lane.waiting.clear();
    }
    this.lanes.clear();
  }

  /**
   * Run `operation` on `executionId`'s lane: claim the lane synchronously,
   * wait for the predecessor and for the live generation, then hold the lane
   * until `operation` and the finalizers it registered settle — which is why
   * the hold is released by the scope rather than by `operation` returning.
   *
   * `refuseWhenOwned` makes the claim conditional: `claim` reports the refusal
   * instead of taking a place, so nothing was acquired and nothing is released.
   */
  private onLane<A, E, R>(
    executionId: string,
    operation: Effect.Effect<A, E, R>,
    refuseWhenOwned?: () => boolean,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const admitted = yield* Effect.acquireRelease(
          Effect.sync(() => this.claim(executionId, refuseWhenOwned)),
          (claim) =>
            Effect.sync(() => {
              if (!(claim instanceof ExecutionBusy)) claim.release();
            }),
        );
        if (admitted instanceof ExecutionBusy) {
          return yield* Effect.fail(admitted);
        }
        yield* admitted.entry;
        return yield* operation;
      }),
    );
  }

  /**
   * Take this fiber's place in `executionId`'s lane. The swap is synchronous
   * so that admission order is call order; `entry` is what the caller waits
   * on, and `release` hands the lane to the successor however the caller
   * left — returned, failed, or interrupted mid-wait.
   *
   * A caller that passes `refuseWhenOwned` refuses competing local ownership
   * rather than queueing behind it: the ownership check reads the lane in the
   * same synchronous step as the tail swap below, so no launch can claim the
   * lane between the two. Refusing leaves the lane exactly as it was found —
   * no entry, no tail link, no `fibers` count, not even a lane on an execution
   * that had none — since it returns before any of them is touched.
   */
  private claim(
    executionId: string,
    refuseWhenOwned: (() => boolean) | undefined,
  ):
    | ExecutionBusy
    | {
        readonly entry: Effect.Effect<void, Error>;
        readonly release: () => void;
      } {
    const occupied = this.lanes.get(executionId);
    if (
      refuseWhenOwned !== undefined &&
      (refuseWhenOwned() ||
        (occupied !== undefined &&
          (occupied.live.size > 0 || occupied.fibers > 0)))
    ) {
      return new ExecutionBusy({ executionId });
    }
    const mine = Deferred.makeUnsafe<void>();
    const refusal = Deferred.makeUnsafe<never, Error>();
    const lane = this.laneFor(executionId);
    const previous = lane.tail;
    lane.tail = mine;
    lane.fibers += 1;
    lane.waiting.add(refusal);
    let entered = previous === undefined;

    const entry = Effect.raceFirst(
      Deferred.await(refusal),
      Effect.gen(function* () {
        if (previous !== undefined) {
          yield* Deferred.await(previous);
          entered = true;
        }
        // Read the gate after the predecessor left: a generation it started
        // is exactly what this step must not overlap. One snapshot, as the
        // predecessor's own wait took one — a generation opened after this
        // read belongs to the step that opened it, not to this one.
        yield* Effect.all(
          [...lane.live].map((generation) => Deferred.await(generation)),
          { concurrency: 'unbounded', discard: true },
        );
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => lane.waiting.delete(refusal))));

    return {
      entry,
      release: () => {
        // A fiber that never entered still owes its successor the wait it was
        // itself doing, so the successor waits for whoever holds the lane.
        Deferred.doneUnsafe(
          mine,
          entered || previous === undefined
            ? Effect.void
            : Deferred.await(previous),
        );
        lane.waiting.delete(refusal);
        lane.fibers -= 1;
        this.forgetIdleLane(executionId, lane);
      },
    };
  }

  private laneFor(executionId: string): ExecutionLane {
    let lane = this.lanes.get(executionId);
    if (!lane) {
      lane = {
        tail: undefined,
        fibers: 0,
        live: new Set(),
        waiting: new Set(),
      };
      this.lanes.set(executionId, lane);
    }
    return lane;
  }

  private forgetIdleLane(executionId: string, lane: ExecutionLane): void {
    if (lane.fibers !== 0 || lane.live.size !== 0) return;
    if (this.lanes.get(executionId) !== lane) return;
    this.lanes.delete(executionId);
  }
}
