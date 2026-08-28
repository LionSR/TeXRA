import { useEffect, useState } from 'react';

import { subscribeToPolling } from './usePollingInterval';

// One shared interval for every live-elapsed display. StatusBar and the
// subagent panel can tick at once; with per-component intervals each would
// fire at its own phase, producing up to one render burst per component per
// second. The 1 Hz cadence of the shared poll registry is that ticker:
// subscribers fire in the same callback, so React batches them into one pass.
// Exported so non-React callers (e.g. the terminal-title updater) can join
// the same 1 Hz registry instead of running a private setInterval.
export function subscribeToSharedTick(subscriber: () => void): () => void {
  return subscribeToPolling(1000, subscriber);
}

export function useLiveNowMs(shouldTick: boolean, resetKey?: unknown): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldTick) return;
    setNowMs(Date.now());
    return subscribeToSharedTick(() => setNowMs(Date.now()));
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
