/**
 * Async utilities - pure async helper functions.
 */

// Re-export debounce from perfect-debounce for consistent usage across codebase
export { debounce } from 'perfect-debounce';

interface DelayOptions {
  readonly signal?: AbortSignal;
}

function createAbortReason(): unknown {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * AbortSignal-aware sleep shared by extension, CLI, and webview code.
 */
export function delay(ms: number, options: DelayOptions = {}): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? createAbortReason());
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);

    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? createAbortReason());
    };

    signal?.addEventListener('abort', abort, { once: true });
  });
}
