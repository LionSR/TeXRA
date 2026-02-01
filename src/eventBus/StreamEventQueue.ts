/**
 * Per-stream event queue for serializing async operations.
 *
 * Solves race conditions where fast event sequences (e.g., addTaskGroup followed
 * by updateTaskGroup) can complete out of order due to async handlers.
 *
 * Events for the same stream are queued and processed sequentially.
 * Events for different streams run in parallel.
 */

// Local imports - logging
import * as logger from '@logger/logUtils';

export class StreamEventQueue {
  private queues = new Map<string, Promise<void>>();

  /**
   * Enqueue an async operation for a given key (e.g., streamId).
   * Operations with the same key run sequentially; different keys run in parallel.
   */
  async enqueue<T>(key: string, handler: () => Promise<T>): Promise<T> {
    const pending = this.queues.get(key) ?? Promise.resolve();
    const next = pending
      .catch((error) => {
        // Ensure failures do not poison the queue for this key.
        logger.warn('TeXRA', '[StreamEventQueue] Handler failed.', {
          data: { key, error },
        });
      })
      .then(handler)
      .finally(() => {
        if (this.queues.get(key) === next) {
          this.queues.delete(key);
        }
      });
    this.queues.set(key, next);
    return next;
  }
}

export const streamEventQueue = new StreamEventQueue();
