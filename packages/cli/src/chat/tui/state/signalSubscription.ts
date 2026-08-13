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
      // Re-arm in `finally`: a Watcher fires once and stays dormant until
      // `watch()` runs again, so letting a throw from `notify()` skip it
      // silently kills this subscription for the rest of the process. For a
      // React subscriber that means a component frozen on stale data with no
      // error and no recovery.
      try {
        notify();
      } finally {
        watcher.watch();
      }
    });
  });
  watcher.watch(...signals);
  return () => {
    disposed = true;
    watcher.unwatch(...signals);
  };
}
