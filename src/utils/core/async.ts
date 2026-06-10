/**
 * Async utilities - pure async helper functions.
 */

// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

// Re-export delay for AbortSignal-aware sleeping: delay(ms, { signal })
export { default as delay } from 'delay';

/**
 * Reject with `new Error(message)` if `promise` doesn't settle within `ms`.
 * The timer is always cleared once the race settles, so a long timeout never
 * keeps the process alive after the underlying promise finishes.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
