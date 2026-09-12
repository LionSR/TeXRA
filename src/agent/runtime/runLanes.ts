/**
 * Lane scheduling for run lifecycles.
 *
 * Owns the per-run serial lanes that `RunRegistry` runs lifecycle
 * steps through, so launch, resume, and delete of one run id never
 * overlap while unrelated runs proceed in parallel.
 *
 * The serialization itself is `withPerKeyLane` (`@utils/core/perKeyQueue`):
 * a `Deferred` hand-off chain rather than a queue, which gives FIFO admission
 * for free and keeps the whole wait interruptible — a caller whose fiber is
 * interrupted while queued hands its successor the wait for whoever actually
 * holds the lane, instead of leaving a task behind in a queue nobody can
 * reach. What this scheduler adds on top are the two facts the generic lane
 * has no notion of: the generation gate ({@link RunLanes.holdLive}) and
 * refusal at session disposal ({@link RunLanes.disposeAll}).
 */

import { Data, Deferred, Effect } from 'effect';

import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

/** A local generation or its retained handle still owns the run. */
export class RunBusy extends Data.TaggedError('RunBusy')<{
  readonly runId: string;
}> {}

/**
 * The serial lifecycle lanes of one session's registry. Launch, resume,
 * delete and any other lifecycle step of one run id run one at a time, and
 * each step first waits for every generation the last launches started to
 * dispose. Generations of one run therefore never coexist: a resume cannot
 * mint a lease while the previous run still holds one, and a delete cannot
 * run under a live run. Stop is a signal to the live generation, not a step.
 */
export class RunLanes {
  /** The hand-off chain per run id; `withPerKeyLane` owns the entries. */
  private readonly lanes = new Map<string, PerKeyLane>();
  /**
   * The completion of every generation of a run still unwinding — held as a
   * set rather than one chained value because they end in no fixed order: a
   * turn's teardown routinely ends while the child loop that outlives it is
   * still live, and clearing the gate on the shorter one would let a resume
   * claim the run under the loop still holding it. A run with no generation
   * unwinding has no entry, so the gate is open exactly when the key is
   * absent.
   */
  private readonly live = new Map<string, Set<Deferred.Deferred<void>>>();
  /**
   * Steps admitted but not yet started, across every run: session disposal
   * fails all of them at once, so they need no per-run keying.
   */
  private readonly waiting = new Set<Deferred.Deferred<never, Error>>();

  /** Acquire an idle run slot, refusing competing local ownership. */
  withInactiveStep<A, E, R>(
    runId: string,
    hasRetainedOwner: () => boolean,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return this.onLane(runId, operation, hasRetainedOwner);
  }

  /** Hold a generation's lane until its Effect and finalizers settle. */
  launch<A, E, R>(
    runId: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return this.onLane(runId, operation);
  }

  /**
   * Add `termination` to the run's live generations.
   *
   * The teardown releases the run lease: it is the tail of the
   * suspended generation, so the lane waits for it before a resume can
   * claim the run again.
   * A child loop's generation stays in the gate until the loop ends; a
   * turn's teardown joins it rather than replacing it, and the gate opens
   * only once every one of them has unwound.
   */
  holdLive(
    runId: string,
    termination: Effect.Effect<void>,
  ): Effect.Effect<void> {
    const completion = Deferred.makeUnsafe<void>();
    const generations =
      this.live.get(runId) ?? new Set<Deferred.Deferred<void>>();
    this.live.set(runId, generations);
    generations.add(completion);
    return termination.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Deferred.doneUnsafe(completion, Effect.void);
          generations.delete(completion);
          if (generations.size === 0 && this.live.get(runId) === generations) {
            this.live.delete(runId);
          }
        }),
      ),
      Effect.uninterruptible,
    );
  }

  /** Refuse every admitted-but-unstarted step and drop all lanes. */
  disposeAll(error: Error): void {
    for (const refusal of this.waiting) {
      Deferred.doneUnsafe(refusal, Effect.fail(error));
    }
    this.waiting.clear();
    this.lanes.clear();
    this.live.clear();
  }

  /**
   * Run `operation` on `runId`'s lane: claim the lane synchronously, wait for
   * the predecessor and then for the live generations, and hold the lane
   * until `operation` settles — including the finalizers it registered, since
   * `withPerKeyLane` releases the lane only once the whole effect leaves.
   *
   * `refuseWhenOwned` makes the claim conditional. Its check reads the lane in
   * the same synchronous step as the tail swap inside `withPerKeyLane`, so no
   * launch can claim the lane between the two, and refusing leaves the lane
   * exactly as it was found — nothing was acquired and nothing is released.
   *
   * A step is refusable from the moment it is admitted until the moment it
   * starts, and `waiting` holds its refusal for exactly that window. The race
   * is therefore around the lane, not inside it: a step still waiting for its
   * predecessor is refused where it stands, and its interruption hands the
   * lane on the same way any other interrupted waiter does.
   */
  private onLane<A, E, R>(
    runId: string,
    operation: Effect.Effect<A, E, R>,
    refuseWhenOwned?: () => boolean,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      if (refuseWhenOwned !== undefined) {
        const occupied = this.lanes.get(runId);
        if (
          refuseWhenOwned() ||
          this.live.has(runId) ||
          (occupied !== undefined && occupied.fibers > 0)
        ) {
          return Effect.fail(new RunBusy({ runId }));
        }
      }
      const refusal = Deferred.makeUnsafe<never, Error>();
      this.waiting.add(refusal);
      const step = Effect.gen({ self: this }, function* () {
        // Read the gate after the predecessor left: a generation it started
        // is exactly what this step must not overlap. One snapshot, as the
        // predecessor's own wait took one — a generation opened after this
        // read belongs to the step that opened it, not to this one.
        const generations = this.live.get(runId);
        if (generations !== undefined) {
          yield* Effect.all(
            [...generations].map((generation) => Deferred.await(generation)),
            { concurrency: 'unbounded', discard: true },
          );
        }
        this.waiting.delete(refusal);
        return yield* operation;
      });
      return Effect.raceFirst(
        Deferred.await(refusal),
        withPerKeyLane(this.lanes, runId)(step),
      ).pipe(Effect.ensuring(Effect.sync(() => this.waiting.delete(refusal))));
    });
  }
}
