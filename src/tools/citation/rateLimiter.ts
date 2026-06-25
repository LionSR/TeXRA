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
  const existing = limiters.get(apiName);
  if (!existing || existing.minDelayMs !== minDelayMs) {
    limiters.set(apiName, {
      minDelayMs,
      wait: pThrottle({ limit: 1, interval: minDelayMs })(() =>
        Promise.resolve(),
      ),
    });
  }
  await limiters.get(apiName)!.wait();
}
