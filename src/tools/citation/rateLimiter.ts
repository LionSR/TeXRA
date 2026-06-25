import pThrottle from 'p-throttle';

const limiters = new Map<string, () => Promise<void>>();

/** Enforces a minimum delay between consecutive requests to the same API. */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  if (!limiters.has(apiName)) {
    limiters.set(
      apiName,
      pThrottle({ limit: 1, interval: minDelayMs })(() => Promise.resolve()),
    );
  }
  await limiters.get(apiName)!();
}
