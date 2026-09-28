/**
 * Process-wide rate budget for the check-run annotations endpoint.
 *
 * The annotations endpoint is paginated and fans out per check-run, so a busy
 * matrix build could otherwise burn through GitHub's primary 5,000/hour limit
 * on annotations alone. This budget caps annotation-page requests across ALL
 * PR subscriptions in the process to a token bucket that continuously
 * refills, independent of the poll interval.
 *
 * The GitHub plugin's process layer (`gitHubSubscriptionsLayer`) builds the
 * one budget of a process and hands it to the one PR polling source, whose
 * `fetchAnnotations` claims against it; it lives and ends with that layer.
 *
 * Token state lives in a `Ref` and `tryClaim` reads its time from Effect's
 * `Clock` by default, rather than a bespoke injectable-clock parameter — the
 * same clock every other retry/backoff path in this codebase uses. This is
 * still a small purpose-built token bucket rather than a library (e.g.
 * `p-throttle`) because callers need a non-blocking claim-or-defer check
 * (`tryClaim`), and `p-throttle` only offers an async queue-and-wait
 * contract.
 */

import { Clock, Data, Effect, Ref } from 'effect';

// Bound annotation endpoint traffic across all PR subscriptions in this
// process. Pagination claims one unit per annotations page, so this budget
// permits at most 3,000 annotation requests per hour, leaving room for the
// rest of the PR polling endpoints under GitHub's primary 5,000/hour limit.
// Keep it independent of the poll interval so tuning
// GITHUB_POLL_INTERVAL_MS does not silently raise the hourly ceiling.
const MAX_PROCESS_ANNOTATION_REQUESTS_PER_WINDOW = 50;
const ANNOTATION_FETCH_BUDGET_WINDOW_MS = 60_000;

export class AnnotationFetchBudgetExhaustedError extends Data.TaggedError(
  'AnnotationFetchBudgetExhaustedError',
) {
  override readonly message = 'Annotation fetch budget exhausted';
}

interface TokenBucketState {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

export class AnnotationFetchBudget {
  private readonly state: Ref.Ref<TokenBucketState>;

  constructor(
    private readonly maxRequestsPerWindow = MAX_PROCESS_ANNOTATION_REQUESTS_PER_WINDOW,
    private readonly windowMs = ANNOTATION_FETCH_BUDGET_WINDOW_MS,
  ) {
    // A plain constructor, so the polling source holds one from its own
    // construction: `makeUnsafe` is `Ref`'s documented synchronous
    // constructor, not an `Effect.run*` boundary call.
    this.state = Ref.makeUnsafe<TokenBucketState>({
      tokens: maxRequestsPerWindow,
      lastRefillMs: Date.now(),
    });
  }

  /**
   * Refill continuously (tokens/ms) rather than resetting the full
   * allowance at fixed window boundaries — a fixed-window reset lets a
   * caller burst up to 2x the budget across a boundary (all of one window's
   * allowance immediately followed by all of the next). A backward clock
   * jump leaves `tokens` unchanged rather than draining it, but still
   * advances `lastRefillMs` so a later forward jump refills from that point.
   */
  private readonly refill = (
    current: TokenBucketState,
    nowMs: number,
  ): TokenBucketState => {
    const elapsedMs = nowMs - current.lastRefillMs;
    if (elapsedMs <= 0) return { ...current, lastRefillMs: nowMs };
    const refillRate = this.maxRequestsPerWindow / this.windowMs;
    return {
      tokens: Math.min(
        this.maxRequestsPerWindow,
        current.tokens + elapsedMs * refillRate,
      ),
      lastRefillMs: nowMs,
    };
  };

  /** Claim one token against `nowMs`, defaulting to Effect's `Clock`. */
  tryClaim(nowMs?: number): Effect.Effect<boolean> {
    const { state, refill } = this;
    return Effect.gen(function* () {
      const now = nowMs ?? (yield* Clock.currentTimeMillis);
      return yield* Ref.modify(state, (current) => {
        const refilled = refill(current, now);
        return refilled.tokens < 1
          ? ([false, refilled] as const)
          : ([true, { ...refilled, tokens: refilled.tokens - 1 }] as const);
      });
    });
  }
}
