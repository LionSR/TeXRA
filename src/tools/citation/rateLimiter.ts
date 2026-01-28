import { delay } from '@utils/core';

/**
 * Simple rate limiter to respect API rate limits for academic metadata services.
 * Ensures minimum delay between consecutive requests to the same API.
 */

const lastRequestTimes = new Map<string, number>();

/**
 * Enforces rate limiting by waiting if necessary before allowing the next request.
 *
 * @param apiName - Unique identifier for the API (e.g., 'arxiv', 'crossref')
 * @param minDelayMs - Minimum milliseconds between requests
 * @returns Promise that resolves when it's safe to make the next request
 */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  const lastTime = lastRequestTimes.get(apiName) ?? 0;
  const elapsed = Date.now() - lastTime;
  const waitTime = minDelayMs - elapsed;

  if (waitTime > 0) {
    await delay(waitTime);
  }

  lastRequestTimes.set(apiName, Date.now());
}
