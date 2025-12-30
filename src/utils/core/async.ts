/**
 * Async utilities - pure async helper functions.
 */

// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

/**
 * Options for exponential backoff delay calculation.
 */
export interface BackoffOptions {
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Jitter strategy: 'full' adds random jitter, 'none' uses exact delay (default: 'full') */
  jitter?: 'full' | 'none';
  /** Exponential factor (default: 2) */
  factor?: number;
}

/**
 * Calculate exponential backoff delay with optional jitter.
 *
 * Uses the "full jitter" algorithm by default, which randomizes the delay
 * between 0 and the calculated exponential delay. This helps prevent
 * thundering herd problems when multiple clients retry simultaneously.
 *
 * Formula: delay = min(maxDelayMs, baseDelayMs * factor^attempt)
 * With full jitter: delay = random(0, delay)
 *
 * @param attempt Current retry attempt (0-indexed, so first retry is 0)
 * @param options Backoff configuration options
 * @returns Delay in milliseconds
 *
 * @example
 * ```typescript
 * // First retry: random(0, 1000)
 * calculateBackoffDelay(0, { baseDelayMs: 1000 });
 *
 * // Second retry: random(0, 2000)
 * calculateBackoffDelay(1, { baseDelayMs: 1000 });
 *
 * // Without jitter: exact exponential delay
 * calculateBackoffDelay(2, { baseDelayMs: 1000, jitter: 'none' }); // 4000
 * ```
 */
export function calculateBackoffDelay(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const {
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = 'full',
    factor = 2,
  } = options;

  // Calculate raw exponential delay
  const exponentialDelay = baseDelayMs * Math.pow(factor, attempt);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Apply jitter strategy
  if (jitter === 'full') {
    // Full jitter: random value between 0 and cappedDelay
    return Math.random() * cappedDelay;
  }

  return cappedDelay;
}

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
