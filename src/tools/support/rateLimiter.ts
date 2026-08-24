// Third-party imports
import pThrottle from 'p-throttle';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { ToolError } from '@shared/schemas';
import { wrapApiCall } from '@tools/utils';

const limiters = new Map<
  string,
  { minDelayMs: number; wait: () => Promise<void> }
>();

/**
 * Enforces a minimum delay between consecutive requests to the same API.
 * Observes the owning run's cancellation: the throttle wait itself is
 * raced against the tool call's abort signal, so an interrupt returns
 * immediately instead of waiting out queued rate-limit slots. The
 * abandoned wait still consumes its slot when it later resolves, which
 * only delays subsequent callers by at most one interval.
 */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  const signal = getCurrentToolCallContext()?.signal;
  let limiter = limiters.get(apiName);
  if (!limiter || limiter.minDelayMs !== minDelayMs) {
    limiter = {
      minDelayMs,
      wait: pThrottle({ limit: 1, interval: minDelayMs })(() =>
        Promise.resolve(),
      ),
    };
    limiters.set(apiName, limiter);
  }
  await abandonOnAbort(limiter.wait(), signal, 'before contacting the API');
}

/**
 * Run a rate-limited, cancellable request against an external metadata API,
 * with uniform error wrapping via {@link wrapApiCall}.
 *
 * Combines the throttle wait ({@link waitForRateLimit}) with cancellation
 * ({@link abandonOnAbort}) against the current tool call's signal, then
 * rethrows failures as a ToolError with a descriptive prefix — the exact
 * pattern every arXiv/Crossref lookup repeats. These clients expose no
 * AbortSignal hook, so on cancellation the in-flight request is *abandoned*:
 * only safe for the idempotent, read-only lookups these tools perform.
 */
export async function rateLimitedApiCall<T>(
  apiName: string,
  minDelayMs: number,
  label: string,
  failureMessage: string,
  request: () => Promise<T>,
): Promise<T> {
  return wrapApiCall(async () => {
    await waitForRateLimit(apiName, minDelayMs);
    return abandonOnAbort(
      request(),
      getCurrentToolCallContext()?.signal,
      label,
    );
  }, failureMessage);
}

/**
 * Race an un-cancellable async operation against the owning tool call's
 * abort signal.
 *
 * On abort the in-flight operation is *abandoned*, not aborted: it settles
 * in the background and its result is discarded, while the caller gets an
 * immediate `ToolError` so a cancelled dispatch batch stops waiting.
 *
 * Only safe for idempotent, read-only operations (GET lookups, throttle
 * waits) — never abandon a write, since it may still complete after the
 * caller has reported cancellation.
 */
export async function abandonOnAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  if (!signal) return operation;
  const cancelled = () => new ToolError(`Cancelled ${what}.`);
  // Register the abort listener BEFORE reading signal.aborted. In today's
  // single-threaded flow nothing runs between the two, but registering first
  // is the robust idiom: it stays correct even if a future edit inserts an
  // await between the aborted-check and the Promise.race, which would
  // otherwise open a window where an abort fires with no listener attached
  // and the race never rejects.
  let removeListener = () => {};
  const abortRace = new Promise<never>((_, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  if (signal.aborted) {
    removeListener();
    // Abandoned operation: swallow its eventual rejection (if any) so the
    // orphaned promise never surfaces as an unhandled rejection.
    operation.catch(() => {});
    throw cancelled();
  }
  try {
    return await Promise.race([operation, abortRace]);
  } catch (error) {
    operation.catch(() => {});
    throw error;
  } finally {
    removeListener();
  }
}
