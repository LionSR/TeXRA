// Third-party imports
import { Mutex } from 'async-mutex';

/** Serialize asynchronous operations independently for each logical key. */
export class KeyedMutex<Key> {
  private readonly mutexes = new Map<Key, Mutex>();

  async runExclusive<Result>(
    key: Key,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    // Setting an existing key keeps its order and value, so this is a no-op
    // for a mutex that already exists.
    const mutex = this.mutexes.get(key) ?? new Mutex();
    this.mutexes.set(key, mutex);
    try {
      return await mutex.runExclusive(operation);
    } finally {
      // No task can interleave in this synchronous check-and-delete segment.
      if (this.mutexes.get(key) === mutex && !mutex.isLocked()) {
        this.mutexes.delete(key);
      }
    }
  }
}
