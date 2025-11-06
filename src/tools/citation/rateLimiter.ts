/**
 * Simple rate limiter to respect API rate limits for academic metadata services.
 * Ensures minimum delay between consecutive requests to the same API.
 */

interface RateLimiterState {
  lastRequestTime: number;
}

const rateLimiters = new Map<string, RateLimiterState>();

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
  const state = rateLimiters.get(apiName) || { lastRequestTime: 0 };
  const now = Date.now();
  const timeSinceLastRequest = now - state.lastRequestTime;

  if (timeSinceLastRequest < minDelayMs) {
    const waitTime = minDelayMs - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    // Use calculated time to avoid drift from async operations
    state.lastRequestTime = now + waitTime;
  } else {
    state.lastRequestTime = now;
  }

  rateLimiters.set(apiName, state);
}
