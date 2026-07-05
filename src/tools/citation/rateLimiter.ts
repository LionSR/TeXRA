import pThrottle from 'p-throttle';

import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { ToolError } from '@shared/schemas/toolResult';

const limiters = new Map<
  string,
  { minDelayMs: number; wait: () => Promise<void> }
>();

/**
 * Enforces a minimum delay between consecutive requests to the same API.
 * Observes the owning run's cancellation: an interrupt during (or before)
 * the throttle wait stops the call from reaching the remote API. The
 * remote call itself may not be abortable (third-party clients), so this
 * wait is the main cancellation point for rate-limited lookup tools.
 */
export async function waitForRateLimit(
  apiName: string,
  minDelayMs: number,
): Promise<void> {
  const signal = getCurrentToolCallContext()?.signal;
  if (signal?.aborted) {
    throw new ToolError('Cancelled before contacting the API.');
  }
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
  await limiter.wait();
  if (signal?.aborted) {
    throw new ToolError('Cancelled before contacting the API.');
  }
}
