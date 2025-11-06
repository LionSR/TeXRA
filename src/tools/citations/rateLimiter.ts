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
  }

  // Update last request time
  state.lastRequestTime = Date.now();
  rateLimiters.set(apiName, state);
}

/**
 * Wraps an async function with rate limiting.
 *
 * @param apiName - Unique identifier for the API
 * @param minDelayMs - Minimum milliseconds between requests
 * @param fn - Async function to execute with rate limiting
 * @returns Wrapped function that enforces rate limits
 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  apiName: string,
  minDelayMs: number,
  fn: T,
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    await waitForRateLimit(apiName, minDelayMs);
    return fn(...args);
  }) as T;
}
