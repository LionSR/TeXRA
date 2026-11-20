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
interface Poll {
  readonly subscribers: Set<PollSubscriber>;
  readonly timer: ReturnType<typeof setInterval>;
}
const polls = new Map<number, Poll>();

export function subscribeToPolling(
  intervalMs: number,
  subscriber: PollSubscriber,
): () => void {
  let poll = polls.get(intervalMs);
  if (poll === undefined) {
    const subscribers = new Set<PollSubscriber>();
    const timer = setInterval(() => {
      for (const sub of subscribers) sub();
    }, intervalMs);
    timer.unref?.();
    poll = { subscribers, timer };
    polls.set(intervalMs, poll);
  }
  const subscribed = poll;
  subscribed.subscribers.add(subscriber);
  return () => {
    // A stale disposer called twice must not touch a later generation's
    // poll at the same cadence.
    if (polls.get(intervalMs) !== subscribed) return;
    subscribed.subscribers.delete(subscriber);
    if (subscribed.subscribers.size > 0) return;
    clearInterval(subscribed.timer);
    polls.delete(intervalMs);
  };
}
