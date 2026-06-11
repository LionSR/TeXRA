import pTimeout from 'p-timeout';

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  // On timeout, abort the in-flight request before rejecting so the
  // connection is actually released. Upstream aborts reject through the
  // fetch itself, preserving the caller's original AbortError.
  return pTimeout(fetchImpl(url, { ...options, signal }), {
    milliseconds: timeoutMs,
    fallback: () => {
      controller.abort();
      throw new Error(timeoutMessage);
    },
  });
}
