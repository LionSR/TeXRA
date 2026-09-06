// Third-party imports
import { Deferred, Effect } from 'effect';
import PQueue from 'p-queue';

interface QueueMap<Key> {
  get(key: Key): PQueue | undefined;
  set(key: Key, queue: PQueue): unknown;
}

/** Return the queue for a key, creating it with the requested concurrency. */
export function getOrCreatePQueue<Key>(
  queues: QueueMap<Key>,
  key: Key,
  concurrency = 1,
): PQueue {
  const existing = queues.get(key);
  if (existing) return existing;

  const queue = new PQueue({ concurrency });
  queues.set(key, queue);
  return queue;
}

/**
 * Run one task on `key`'s serial queue, creating the queue on first use and
 * deleting it from `queues` once the task settles with nothing queued behind
 * it — the idle-cleanup epilogue that each Map-based call site previously
 * carried as its own copy. The identity check keeps a stale settle from
 * deleting a successor queue installed under the same key. (WeakMap-keyed
 * queues don't need this: their lifetime is the key's own.)
 */
export async function runOnPerKeyQueue<Key, T>(
  queues: Map<Key, PQueue>,
  key: Key,
  task: () => Promise<T> | T,
): Promise<T> {
  const queue = getOrCreatePQueue(queues, key);
  try {
    // `add` widens to `T | void` to cover abort via signal/timeout; neither
    // is passed, so the task always runs and settles with `T`.
    return (await queue.add(task)) as T;
  } finally {
    if (queue.pending === 0 && queue.size === 0 && queues.get(key) === queue) {
      queues.delete(key);
    }
  }
}

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
 * Run `self` on `key`'s lane — the Effect-side sibling of
 * {@link runOnPerKeyQueue}, and FIFO like it: each entrant claims the lane
 * synchronously when its effect starts by swapping its own `Deferred` in as
 * the tail, waits for its predecessor's, and hands off in `ensuring` once
 * `self` succeeds, fails, or is interrupted. The wait itself is
 * interruptible; a waiter interrupted before entering hands its successor
 * the wait for its own predecessor, so the successor still waits for whoever
 * actually holds the lane. A hand-off through a `Deferred` resumes the next
 * fiber directly, so fibers started in sequence enter in that order — a
 * `Semaphore` barges: its release wakes waiters in a scheduled task, and a
 * fiber started in between takes the free permit ahead of them. The lane is
 * created on first use and deleted from `lanes` once the last fiber holding
 * or waiting on it settles.
 */
export function withPerKeyLane<Key>(
  lanes: Map<Key, PerKeyLane>,
  key: Key,
): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (self) =>
    Effect.suspend(() => {
      const mine = Deferred.makeUnsafe<void>();
      const existing = lanes.get(key);
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
      return run.pipe(
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
    });
}
