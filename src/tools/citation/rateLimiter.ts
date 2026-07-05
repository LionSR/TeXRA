// Third-party imports
import pThrottle from 'p-throttle';

// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { abandonOnAbort } from '@tools/cancellation';

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
 * Run a rate-limited, cancellable request against an external metadata API.
 *
 * Combines the throttle wait ({@link waitForRateLimit}) with cancellation
 * ({@link abandonOnAbort}) against the current tool call's signal — the exact
 * pattern every arXiv/Crossref lookup repeats. These clients expose no
 * AbortSignal hook, so on cancellation the in-flight request is *abandoned*:
 * only safe for the idempotent, read-only lookups these tools perform.
 */
export async function rateLimitedRequest<T>(
  apiName: string,
  minDelayMs: number,
  label: string,
  request: () => Promise<T>,
): Promise<T> {
  await waitForRateLimit(apiName, minDelayMs);
  return abandonOnAbort(request(), getCurrentToolCallContext()?.signal, label);
}
