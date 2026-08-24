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
