// Third-party imports
import { Deferred, Effect } from 'effect';

/**
 * One in-process exclusive lane per key for Effect programs: the `Deferred`
 * the most recent entrant completes when it leaves, plus the number of
 * fibers holding or waiting on the lane. The count is what lets the entry
 * leave its map once the last fiber settles.
 */
export interface PerKeyLane {
  tail: Deferred.Deferred<void>;
  fibers: number;
}

/**
 * Where the lanes live. A `Map` is the usual choice; a `WeakMap` keyed by an
 * owning object works too and does not need the idle cleanup (its entries'
 * lifetime is the key's own), which is why only these three methods are
 * required.
 */
export interface PerKeyLanes<Key> {
  get(key: Key): PerKeyLane | undefined;
  set(key: Key, lane: PerKeyLane): unknown;
  delete(key: Key): unknown;
}

/**
 * Run `self` on `key`'s lane, FIFO: each entrant claims the lane
 * synchronously when its effect starts by swapping its own `Deferred` in as
 * the tail, waits for its predecessor's, and hands off in `ensuring` once
 * `self` succeeds, fails, or is interrupted. A waiter interrupted before
 * entering hands its successor the wait for its own predecessor, so the
 * successor still waits for whoever actually holds the lane. A hand-off through a `Deferred` resumes the next
 * fiber directly, so fibers started in sequence enter in that order. The
 * lane is created on first use and deleted from `lanes` once the last fiber
 * holding or waiting on it settles.
 *
 * A `Queue` of tickets served by one detached worker fiber (the shape
 * `sessionFrames.ts` uses) was prototyped against this chain in review and
 * not taken. FIFO came for free, but `Queue.make` is `withFiber`, so the
 * queue cannot be created in the synchronous claim step: the create path
 * had to re-check the map after `Queue.unbounded` and claim in the same
 * synchronous step as the insert, because a lane whose count drops to zero
 * ends its queue and a ticket offered to an ended queue waits forever. Its
 * interruption handling was the same single `ensuring` as here, with the
 * body still on the caller's fiber, and it was longer while adding two
 * lifecycle cases (raced creation, ended queue) that the chain does not have.
 *
 * The claim and the registration of its release are one uninterruptible
 * step. A fiber can yield between any two steps once it has used its
 * scheduler budget, and an interruption arriving then replaces the step it
 * was about to run: were the claim interruptible, that could be the step
 * that registers the release, and the lane would stay claimed by a fiber
 * that is gone, with every later entrant waiting on it. Only the wait and
 * `self` are interruptible.
 */
export function withPerKeyLane<Key>(
  lanes: PerKeyLanes<Key>,
  key: Key,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (self) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const existing = lanes.get(key);
        const mine = Deferred.makeUnsafe<void>();
        const previous = existing?.tail;
        const held = existing ?? { tail: mine, fibers: 0 };
        if (!existing) lanes.set(key, held);
        held.tail = mine;
        held.fibers += 1;
        let entered = previous === undefined;
        const run =
          previous === undefined
            ? self
            : Effect.flatMap(Deferred.await(previous), () => {
                entered = true;
                return self;
              });
        return restore(run).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              Deferred.doneUnsafe(
                mine,
                previous === undefined || entered
                  ? Effect.void
                  : Deferred.await(previous),
              );
              held.fibers -= 1;
              if (held.fibers === 0 && lanes.get(key) === held) {
                lanes.delete(key);
              }
            }),
          ),
        );
      }),
    );
}
