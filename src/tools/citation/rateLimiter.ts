import pThrottle from 'p-throttle';

interface ApiLimiter {
  minDelayMs: number;
  wait: () => Promise<void>;
}

const limiters = new Map<string, ApiLimiter>();

function getLimiter(apiName: string, minDelayMs: number): ApiLimiter {
  const existing = limiters.get(apiName);
  if (existing && existing.minDelayMs === minDelayMs) {
    return existing;
  }
  // p-throttle's interval is fixed at creation, so a changed delay (callers
  // pass a constant per API in practice) rebuilds the limiter.
  const throttle = pThrottle({ limit: 1, interval: minDelayMs });
  const limiter: ApiLimiter = {
    minDelayMs,
    wait: throttle(() => Promise.resolve()),
  };
  limiters.set(apiName, limiter);
  return limiter;
}

/** Enforces a minimum delay between consecutive requests to the same API. */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  await getLimiter(apiName, minDelayMs).wait();
}
