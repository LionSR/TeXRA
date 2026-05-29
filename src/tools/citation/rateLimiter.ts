import Bottleneck from 'bottleneck';

const limiters = new Map<string, Bottleneck>();

function getLimiter(apiName: string, minDelayMs: number): Bottleneck {
  const existing = limiters.get(apiName);
  if (existing) {
    void existing.updateSettings({ minTime: minDelayMs });
    return existing;
  }
  const limiter = new Bottleneck({ minTime: minDelayMs, maxConcurrent: 1 });
  limiters.set(apiName, limiter);
  return limiter;
}

/** Enforces a minimum delay between consecutive requests to the same API. */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  await getLimiter(apiName, minDelayMs).schedule(() => Promise.resolve());
}
