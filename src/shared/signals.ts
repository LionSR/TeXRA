/**
 * Signal utilities shared across all webview apps.
 *
 * Re-exports from @lit-labs/signals and provides helpers
 * for extracting fields from monolithic signals.
 */

import { SignalWatcher, signal, Signal } from '@lit-labs/signals';

export { SignalWatcher, Signal };

/**
 * Selector: extracts a field from a monolithic signal.
 * Only propagates when the selected value's reference changes.
 * Works with Mutative's structural sharing — unchanged branches
 * keep their reference, so Object.is() correctly skips propagation.
 */
export function select<S, T>(
  source: Signal.State<S>,
  selector: (state: S) => T,
): Signal.Computed<T> {
  return new Signal.Computed(() => selector(source.get()));
}

/**
 * Creates an independent `trackedSignal`/`resetAll` pair for a state module.
 * `trackedSignal` declares a writable signal and registers its reset
 * callback in the same expression, so a module's `resetAll()` can replay
 * every signal's own default-value factory instead of a hand-written,
 * independently-ordered sequence of `.set()` calls that can drift from the
 * declaration list. `initialValue` is a factory (not a bare value) so every
 * reset — like every fresh mount — constructs an independent value rather
 * than reusing one shared object reference.
 *
 * Each caller gets its own registry (the callbacks array is captured in the
 * closure below), so multiple state modules can each call this once at
 * module scope without sharing reset state.
 */
export function createTrackedSignalRegistry() {
  const resetCallbacks: Array<() => void> = [];

  function trackedSignal<T>(initialValue: () => T): Signal.State<T> {
    const s = signal(initialValue());
    resetCallbacks.push(() => s.set(initialValue()));
    return s;
  }

  function resetAll(): void {
    for (const reset of resetCallbacks) {
      reset();
    }
  }

  return { trackedSignal, resetAll };
}

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
      // Read every pending computed so the watcher re-tracks its dependencies.
      // A watched `Signal.State` never reports pending, so this is a no-op for
      // subscribers that watch state signals directly.
      for (const pending of watcher.getPending()) pending.get();
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
