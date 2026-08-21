import { useEffect, useState } from 'react';

// One shared interval for every live-elapsed display. StatusBar and the
// subagent panel can tick at once; with per-component intervals each would
// fire at its own phase, producing up to one render burst per component per
// second. Subscribers of the shared ticker fire in the same callback, so
// React batches them into one pass.
type SharedTickSubscriber = () => void;
const tickSubscribers = new Set<SharedTickSubscriber>();
let tickTimer: ReturnType<typeof setInterval> | undefined;

// Exported so non-React callers (e.g. the terminal-title updater) can join
// the same 1 Hz registry instead of running a private setInterval.
export function subscribeToSharedTick(
  subscriber: SharedTickSubscriber,
): () => void {
  tickSubscribers.add(subscriber);
  tickTimer ??= setInterval(() => {
    for (const tick of tickSubscribers) tick();
  }, 1000);
  return () => {
    tickSubscribers.delete(subscriber);
    if (tickSubscribers.size === 0 && tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
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
