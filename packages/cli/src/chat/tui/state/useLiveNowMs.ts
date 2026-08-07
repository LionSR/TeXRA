import { useEffect, useState } from 'react';

// One shared interval for every live-elapsed display. StatusBar and the
// subagent panel can tick at once; with per-component intervals each would
// fire at its own phase, producing up to one render burst per component per
// second. Subscribers of the shared ticker fire in the same callback, so
// React batches them into one pass.
type SharedTickSubscriber = () => void;
const tickSubscribers = new Set<SharedTickSubscriber>();
let tickTimer: ReturnType<typeof setInterval> | undefined;

function subscribeToSharedTick(subscriber: SharedTickSubscriber): () => void {
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
