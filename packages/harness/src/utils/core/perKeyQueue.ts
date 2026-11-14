// Third-party imports
import { Effect, Semaphore } from 'effect';

/**
 * One in-process exclusive lane per key for Effect programs: the key's
 * `Semaphore`, and the number of fibers holding or waiting on it. The count
 * is what lets the entry leave its map once the last fiber is done.
 */
export interface PerKeyLane {
  readonly lock: Semaphore.Semaphore;
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
 * Run `self` holding `key`'s one permit. The exclusion, the queue and its
 * release under interruption are the `Semaphore`'s: a fiber joins the key's
 * queue and enters in the order it joined, and a waiter that is interrupted
 * leaves the queue. What this adds is the keyed map: the lane is created on
 * first use, counted while a fiber holds or waits on it, and deleted from
 * `lanes` when the count returns to zero. The count is taken and given back
 * as one acquire and release, so no exit leaves a key counted.
 *
 * Order is the order fibers join the semaphore's queue, a few steps after
 * they call this. Two fibers that call within those steps of each other,
 * with the scheduler taking the first one off in between, can enter in the
 * other order (measured at 8 of 2101 step offsets at the default budget,
 * against 2 for a bare `Semaphore`). A caller that must keep the order of
 * its calls puts them through one consumer, not a lane.
 */
export function withPerKeyLane<Key>(
  lanes: PerKeyLanes<Key>,
  key: Key,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (self) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const lane = lanes.get(key) ?? {
          lock: Semaphore.makeUnsafe(1),
          fibers: 0,
        };
        lanes.set(key, lane);
        lane.fibers += 1;
        return lane;
      }),
      (lane) => lane.lock.withPermit(self),
      (lane) =>
        Effect.sync(() => {
          lane.fibers -= 1;
          if (lane.fibers === 0 && lanes.get(key) === lane) lanes.delete(key);
        }),
    );
}
