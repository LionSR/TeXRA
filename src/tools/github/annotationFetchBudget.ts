/**
 * Process-wide rate budget for the check-run annotations endpoint.
 *
 * The annotations endpoint is paginated and fans out per check-run, so a busy
 * matrix build could otherwise burn through GitHub's primary 5,000/hour limit
 * on annotations alone. This budget caps annotation-page requests across ALL
 * PR subscriptions in the process to a fixed allowance per sliding window,
 * independent of the poll interval.
 *
 * A single shared singleton (`annotationFetchBudget`) is the authority; the
 * infrastructure `fetchAnnotations` claims against it and `PRPollingSource`
 * exposes a test-only reset that targets the same instance.
 */

// Bound annotation endpoint traffic across all PR subscriptions in this
// process. Pagination claims one unit per annotations page, so this 60s budget
// window permits at most 3,000 annotation requests per hour, leaving room for
// the rest of the PR polling endpoints under GitHub's primary 5,000/hour limit.
// Keep it independent of the poll interval so tuning PR_POLL_INTERVAL_MS does
// not silently raise the hourly ceiling.
export const MAX_PROCESS_ANNOTATION_REQUESTS_PER_WINDOW = 50;
export const ANNOTATION_FETCH_BUDGET_WINDOW_MS = 60_000;

export class AnnotationFetchBudgetExhaustedError extends Error {
  constructor() {
    super('Annotation fetch budget exhausted');
  }
}

export class AnnotationFetchBudget {
  private windowStartMs: number;
  private remainingRequests: number;

  constructor(
    private readonly maxRequestsPerWindow: number,
    private readonly windowMs: number,
  ) {
    this.windowStartMs = Date.now();
    this.remainingRequests = maxRequestsPerWindow;
  }

  tryClaim(nowMs = Date.now()): boolean {
    if (nowMs - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = nowMs;
      this.remainingRequests = this.maxRequestsPerWindow;
    }
    if (this.remainingRequests <= 0) return false;
    this.remainingRequests -= 1;
    return true;
  }

  resetForTests(
    remainingRequests = this.maxRequestsPerWindow,
    nowMs = Date.now(),
  ): void {
    this.windowStartMs = nowMs;
    this.remainingRequests = Math.max(
      0,
      Math.min(this.maxRequestsPerWindow, remainingRequests),
    );
  }
}

/** Process-wide singleton shared by every PR subscription. */
export const annotationFetchBudget = new AnnotationFetchBudget(
  MAX_PROCESS_ANNOTATION_REQUESTS_PER_WINDOW,
  ANNOTATION_FETCH_BUDGET_WINDOW_MS,
);
