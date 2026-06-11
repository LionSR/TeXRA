/**
 * Async utilities - pure async helper functions.
 */

import pTimeout from 'p-timeout';

// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

// Re-export delay for AbortSignal-aware sleeping: delay(ms, { signal })
export { default as delay } from 'delay';

/**
 * Reject with `new Error(message)` if `promise` doesn't settle within `ms`.
 * Backed by `p-timeout`, which clears its timer once the race settles, so a
 * long timeout never keeps the process alive after the underlying promise
 * finishes.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return pTimeout(promise, { milliseconds: ms, message: new Error(message) });
}
