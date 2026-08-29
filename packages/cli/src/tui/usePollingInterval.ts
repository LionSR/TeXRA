import { useEffect, useRef } from 'react';

/**
 * Shared poll registry: one interval per cadence, so N live surfaces never
 * each own a timer. Without it, per-component intervals would each fire at
 * their own phase, producing up to one render burst per component per period.
 * Subscribers at the same cadence fire in one callback, so React batches their
 * re-renders into one pass. The timer is unref'd so a poll can never hold the
 * process open on its own, and is torn down once the last subscriber
 * unsubscribes. Non-React callers (e.g. the terminal-title updater) join the
 * same registry instead of running a private setInterval.
 */
type PollSubscriber = () => void;
const pollSubscribers = new Map<number, Set<PollSubscriber>>();
const pollTimers = new Map<number, ReturnType<typeof setInterval>>();

export function subscribeToPolling(
  intervalMs: number,
  subscriber: PollSubscriber,
): () => void {
  let subscribers = pollSubscribers.get(intervalMs);
  if (subscribers === undefined) {
    subscribers = new Set();
    pollSubscribers.set(intervalMs, subscribers);
  }
  subscribers.add(subscriber);
  if (!pollTimers.has(intervalMs)) {
    const timer = setInterval(() => {
      for (const sub of pollSubscribers.get(intervalMs) ?? []) sub();
    }, intervalMs);
    timer.unref?.();
    pollTimers.set(intervalMs, timer);
  }
  return () => {
    // Re-read the live entry rather than the Set captured at subscribe time:
    // a stale disposer called twice must not clear a later generation's timer
    // out from under its subscribers.
    const live = pollSubscribers.get(intervalMs);
    if (live === undefined) return;
    live.delete(subscriber);
    if (live.size > 0) return;
    const timer = pollTimers.get(intervalMs);
    if (timer !== undefined) clearInterval(timer);
    pollTimers.delete(intervalMs);
    pollSubscribers.delete(intervalMs);
  };
}

/**
 * Poll `fn` every `intervalMs`, firing once immediately on mount. The latest
 * `fn` is always used (held in a ref, not a dependency), so callers may pass a
 * fresh closure each render. Changing `resetKey` re-fires immediately and
 * re-arms the interval — use it for the dependencies that previously lived in
 * a `useEffect` dependency array.
 */
export function usePollingInterval(
  fn: () => void,
  intervalMs: number,
  resetKey?: unknown,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    fnRef.current();
    return subscribeToPolling(intervalMs, () => fnRef.current());
  }, [intervalMs, resetKey]);
}
