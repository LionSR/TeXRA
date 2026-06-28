import pThrottle from 'p-throttle';

const limiters = new Map<
  string,
  { minDelayMs: number; wait: () => Promise<void> }
>();

/** Enforces a minimum delay between consecutive requests to the same API. */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  let limiter = limiters.get(apiName);
  if (!limiter || limiter.minDelayMs !== minDelayMs) {
    limiter = {
      minDelayMs,
      wait: pThrottle({ limit: 1, interval: minDelayMs })(() =>
        Promise.resolve(),
      ),
    };
    limiters.set(apiName, limiter);
  }
  await limiter.wait();
}
