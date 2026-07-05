export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Generic counting semaphore bounding concurrent async tasks (tool dispatch
 * batches, workflow-script agent() calls). A released slot is handed
 * directly to the next waiter (active count unchanged) so a synchronous
 * newcomer cannot steal it and overshoot the limit. Kept hand-rolled
 * deliberately: p-queue (the in-repo alternative) types `add()` as
 * `Promise<T | void>`, which would force assertions at every call site.
 */
export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }
  // active == count of currently occupied slots, including slots handed
  // directly to resumed waiters (which never decrement/re-increment).
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await task();
      } finally {
        const next = waiters.shift();
        if (next) {
          next();
        } else {
          active -= 1;
        }
      }
    },
  };
}
