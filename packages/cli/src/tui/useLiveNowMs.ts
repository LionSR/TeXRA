import { useEffect, useState } from 'react';

import { subscribeToPolling } from './usePollingInterval';

export function useLiveNowMs(shouldTick: boolean, resetKey?: unknown): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldTick) return;
    setNowMs(Date.now());
    return subscribeToPolling(1000, () => setNowMs(Date.now()));
  }, [resetKey, shouldTick]);

  return nowMs;
}

/**
 * Variant of {@link useLiveNowMs} for "has any of these runs started yet?",
 * derived from a list of candidate `runStartedAt` timestamps. The live-elapsed
 * key (the distinct starts, joined) is computed here so callers don't
 * hand-build the `.filter(...).join(':')` key purely to feed it back in.
 */
export function useLiveNowMsSince(
  startedAts: readonly (number | undefined)[],
): number {
  const key = startedAts
    .filter((startedAt): startedAt is number => startedAt !== undefined)
    .join(':');
  return useLiveNowMs(key.length > 0, key);
}
