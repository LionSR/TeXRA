import { isAbortError } from '@common/errors';

export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const { signal, cleanup } = combineAbortSignals(
    options.signal ?? undefined,
    controller.signal,
  );
  try {
    return await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (isAbortError(error)) {
      if (options.signal?.aborted && !controller.signal.aborted) {
        throw error;
      }
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    cleanup();
    clearTimeout(timeoutId);
  }
}

function combineAbortSignals(
  upstreamSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!upstreamSignal) {
    return { signal: timeoutSignal, cleanup: () => {} };
  }

  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([upstreamSignal, timeoutSignal]),
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  upstreamSignal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  if (upstreamSignal.aborted || timeoutSignal.aborted) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      upstreamSignal.removeEventListener('abort', abort);
      timeoutSignal.removeEventListener('abort', abort);
    },
  };
}
