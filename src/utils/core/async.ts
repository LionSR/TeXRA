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
 * Uses AbortSignal.timeout() when available for better performance.
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
    await sleep(ms);
    return;
  }

  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  const supportsAbortTimeout = typeof AbortSignal.timeout === 'function';

  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timeoutSignal: AbortSignal | undefined;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      timeoutSignal?.removeEventListener('abort', onTimeout);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    const onTimeout = () => {
      cleanup();
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });

    if (supportsAbortTimeout) {
      timeoutSignal = AbortSignal.timeout(ms);
      timeoutSignal.addEventListener('abort', onTimeout, { once: true });
    } else {
      timeoutId = setTimeout(onTimeout, ms);
    }
  });
}
