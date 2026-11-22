import { Predicate } from 'effect';
import { useEffect, useState } from 'react';

/**
 * The TUI's one live clock: a single 1 Hz timer that reads the wall clock
 * once per tick and hands that reading to every subscriber, so N live
 * surfaces never each own a timer or each read the time. Subscribers fire in
 * one callback, so React batches their re-renders into one pass. The timer
 * is unref'd so the clock can never hold the process open on its own, and
 * stops once the last subscriber unsubscribes. Non-React callers (the
 * terminal-title updater) join it instead of running a private setInterval.
 */
type ClockSubscriber = (nowMs: number) => void;

const subscribers = new Set<ClockSubscriber>();
let timer: ReturnType<typeof setInterval> | undefined;

export function subscribeToClock(subscriber: ClockSubscriber): () => void {
  subscribers.add(subscriber);
  if (timer === undefined) {
    timer = setInterval(() => {
      const nowMs = Date.now();
      for (const sub of subscribers) sub(nowMs);
    }, 1000);
    timer.unref?.();
  }
  return () => {
    if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/** The live clock's time, re-rendering on each tick while `shouldTick`; a
 *  new `resetKey` reads the time afresh at once. */
export function useLiveNowMs(shouldTick: boolean, resetKey?: unknown): number {
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (!shouldTick) return;
    setNowMs(Date.now());
    return subscribeToClock(setNowMs);
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
  const key = startedAts.filter(Predicate.isNotUndefined).join(':');
  return useLiveNowMs(key.length > 0, key);
}
