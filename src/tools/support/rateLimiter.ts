// Third-party imports
import { Cause, Clock, Data, Duration, Effect, Exit, Semaphore } from 'effect';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { effectRuntime } from '@platform/processRuntime';
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

/** The API request rejected; `cause` is the client's own error. */
class ApiCallFailed extends Data.TaggedError('ApiCallFailed')<{
  readonly cause: unknown;
}> {}

const rateLimitedRequest = Effect.fn('rateLimiter.rateLimitedApiCall')(
  <T>(apiName: string, minDelayMs: number, request: () => Promise<T>) =>
    Effect.gen(function* () {
      yield* acquireRateLimitSlot(apiName, minDelayMs);
      // These clients expose no AbortSignal hook, so on interruption the
      // in-flight request is *abandoned*: it settles in the background and
      // its result is discarded. Only safe for the idempotent, read-only
      // lookups these tools perform — never abandon a write.
      return yield* Effect.tryPromise({
        try: () => request(),
        catch: (cause) => new ApiCallFailed({ cause }),
      });
    }),
);

/**
 * Run a rate-limited, cancellable request against an external metadata API
 * with uniform error wrapping — the exact pattern every arXiv/Crossref
 * lookup repeats.
 *
 * Waits for the API's next slot ({@link acquireRateLimitSlot}), runs the
 * request, and rethrows failures as a `ToolError` prefixed with
 * `failureMessage` (a `ToolError` the request throws itself passes through
 * unchanged). Cancelling the current tool call interrupts the slot wait and
 * abandons the in-flight request, and the caller gets an immediate
 * `ToolError('Cancelled <label>.')` so a cancelled dispatch batch stops
 * waiting. Both phases raise that one message; the p-throttle version said
 * `Cancelled before contacting the API.` for the slot wait, a string no
 * caller matched on.
 */
export async function rateLimitedApiCall<T>(
  apiName: string,
  minDelayMs: number,
  label: string,
  failureMessage: string,
  request: () => Promise<T>,
): Promise<T> {
  const exit = await effectRuntime().runPromiseExit(
    rateLimitedRequest(apiName, minDelayMs, request),
    { signal: getCurrentToolCallContext()?.signal },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new ToolError(`Cancelled ${label}.`);
  }
  const failure = Cause.squash(exit.cause);
  if (!(failure instanceof ApiCallFailed)) throw failure;
  if (failure.cause instanceof ToolError) throw failure.cause;
  throw new ToolError(`${failureMessage}: ${toErrorMessage(failure.cause)}`, {
    cause: failure.cause,
  });
}
