// Third-party imports
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
