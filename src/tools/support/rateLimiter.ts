/**
 * Per-API request rate limiting for the metadata lookups (arXiv, Crossref).
 *
 * The limiters are keyed by API name in one module-level map: a limit is a
 * property of the remote API, shared by every tool call in the process, so
 * it cannot live in a layer a tool's run edge provides — `Effect.provide`
 * builds a layer afresh per call (the process `ManagedRuntime` does not seed
 * `CurrentMemoMap` into fibers), which would leave each call with its own
 * limiter and no limit at all.
 */

// Third-party imports
import { Clock, Duration, Effect, Semaphore } from 'effect';

// Local imports
import { ToolError } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface Limiter {
  readonly minDelayMs: number;
  /** One permit: waiters take their slot in arrival order. */
  readonly gate: Semaphore.Semaphore;
  /** Clock time at which the next request may start. */
  nextSlotAt: number;
}

const limiters = new Map<string, Limiter>();

/**
 * Take the next request slot for `apiName`: at most one request starts per
 * `minDelayMs`, waiters run in arrival order, and an interrupted waiter
 * gives its place back instead of consuming a slot nobody uses.
 */
export const acquireRateLimitSlot = Effect.fn(
  'rateLimiter.acquireRateLimitSlot',
)(function* (apiName: string, minDelayMs: number) {
  let limiter = limiters.get(apiName);
  if (!limiter || limiter.minDelayMs !== minDelayMs) {
    limiter = { minDelayMs, gate: Semaphore.makeUnsafe(1), nextSlotAt: 0 };
    limiters.set(apiName, limiter);
  }
  const slot = limiter;
  yield* Semaphore.withPermit(slot.gate)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now < slot.nextSlotAt) {
        yield* Effect.sleep(Duration.millis(slot.nextSlotAt - now));
      }
      slot.nextSlotAt = (yield* Clock.currentTimeMillis) + minDelayMs;
    }),
  );
});

/**
 * A rate-limited request against an external metadata API with uniform
 * error wrapping — the exact pattern every arXiv/Crossref lookup repeats.
 *
 * Waits for the API's next slot ({@link acquireRateLimitSlot}), runs the
 * request, and fails with a `ToolError` prefixed with `failureMessage` (a
 * `ToolError` the request throws itself passes through unchanged).
 * Interruption stops the slot wait; these clients expose no AbortSignal
 * hook, so an interrupted in-flight request is *abandoned*: it settles in
 * the background and its result is discarded. Only safe for the idempotent,
 * read-only lookups these tools perform — never abandon a write.
 */
export const rateLimitedApiCall = Effect.fn('rateLimiter.rateLimitedApiCall')(
  <T>(
    apiName: string,
    minDelayMs: number,
    failureMessage: string,
    request: () => Promise<T>,
  ) =>
    Effect.gen(function* () {
      yield* acquireRateLimitSlot(apiName, minDelayMs);
      return yield* Effect.tryPromise({
        try: () => request(),
        catch: (cause) =>
          cause instanceof ToolError
            ? cause
            : new ToolError(`${failureMessage}: ${toErrorMessage(cause)}`, {
                cause,
              }),
      });
    }),
);
