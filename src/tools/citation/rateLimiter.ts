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
