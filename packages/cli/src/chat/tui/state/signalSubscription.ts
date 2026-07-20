import { Signal } from '@lit-labs/signals';

type WatchableSignal = Parameters<Signal.subtle.Watcher['watch']>[number];

/**
 * Subscribe to one or more signals outside their notification phase.
 *
 * Signal Watchers fire only once until re-armed, and their notification phase
 * forbids signal reads. Coalesce notifications into one microtask so callers
 * may safely read the current graph, then re-arm unless the subscription was
 * disposed while that microtask was pending.
 */
export function subscribeToSignalChanges(
  signals: readonly WatchableSignal[],
  notify: () => void,
): () => void {
  let notifyPending = false;
  let disposed = false;
  const watcher = new Signal.subtle.Watcher(() => {
    if (notifyPending) return;
    notifyPending = true;
    queueMicrotask(() => {
      notifyPending = false;
      if (disposed) return;
      notify();
      watcher.watch();
    });
  });
  watcher.watch(...signals);
  return () => {
    disposed = true;
    watcher.unwatch(...signals);
  };
}
