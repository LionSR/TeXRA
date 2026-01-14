/**
 * Async utilities - pure async helper functions.
 */

// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

/**
 * Asynchronously wait for the specified number of milliseconds.
 * @param ms Number of milliseconds to sleep
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the specified duration with support for AbortSignal cancellation.
 * If the signal is aborted before the timeout completes, throws an AbortError.
 *
 * @param ms Number of milliseconds to wait
 * @param signal Optional AbortSignal to allow cancellation
 * @throws DOMException with name 'AbortError' if signal is aborted
 */
export async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }

  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
