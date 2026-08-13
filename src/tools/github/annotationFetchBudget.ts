/**
 * Process-wide rate budget for the check-run annotations endpoint.
 *
 * The annotations endpoint is paginated and fans out per check-run, so a busy
 * matrix build could otherwise burn through GitHub's primary 5,000/hour limit
 * on annotations alone. This budget caps annotation-page requests across ALL
 * PR subscriptions in the process to a token bucket that continuously
 * refills, independent of the poll interval.
 *
 * A single shared singleton (`SharedAnnotationFetchBudget`) is the authority; the
 * infrastructure `fetchAnnotations` claims against it and `PRPollingSource`
 * exposes a test-only reset that targets the same instance.
 *
 * This is a small hand-rolled token bucket rather than a library (e.g.
 * `p-throttle`) because callers need a synchronous, non-blocking
 * claim-or-defer check (`tryClaim`) with an injectable clock for
 * deterministic tests (`resetForTests`) — `p-throttle` only offers an async
 * queue-and-wait contract, which doesn't fit either requirement.
 */

import { clamp } from '@utils/core';

// Bound annotation endpoint traffic across all PR subscriptions in this
// process. Pagination claims one unit per annotations page, so this budget
// permits at most 3,000 annotation requests per hour, leaving room for the
// rest of the PR polling endpoints under GitHub's primary 5,000/hour limit.
// Keep it independent of the poll interval so tuning PR_POLL_INTERVAL_MS does
// not silently raise the hourly ceiling.
const MAX_PROCESS_ANNOTATION_REQUESTS_PER_WINDOW = 50;
const ANNOTATION_FETCH_BUDGET_WINDOW_MS = 60_000;

export class AnnotationFetchBudgetExhaustedError extends Error {
  constructor() {
    super('Annotation fetch budget exhausted');
  }
}

export class AnnotationFetchBudget {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly maxRequestsPerWindow: number,
    private readonly windowMs: number,
  ) {
    this.tokens = maxRequestsPerWindow;
    this.lastRefillMs = Date.now();
  }

  /**
   * Refill continuously (tokens/ms) rather than resetting the full
   * allowance at fixed window boundaries — a fixed-window reset lets a
   * caller burst up to 2x the budget across a boundary (all of one window's
   * allowance immediately followed by all of the next).
   */
  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs > 0) {
      const refillRate = this.maxRequestsPerWindow / this.windowMs;
      this.tokens = Math.min(
        this.maxRequestsPerWindow,
        this.tokens + elapsedMs * refillRate,
      );
    }
    this.lastRefillMs = nowMs;
  }

  tryClaim(nowMs = Date.now()): boolean {
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  resetForTests(
    remainingRequests = this.maxRequestsPerWindow,
    nowMs = Date.now(),
  ): void {
    this.lastRefillMs = nowMs;
    this.tokens = clamp(remainingRequests, 0, this.maxRequestsPerWindow);
  }
}

/** Process-wide singleton shared by every PR subscription. */
export const SharedAnnotationFetchBudget = new AnnotationFetchBudget(
  MAX_PROCESS_ANNOTATION_REQUESTS_PER_WINDOW,
  ANNOTATION_FETCH_BUDGET_WINDOW_MS,
);
