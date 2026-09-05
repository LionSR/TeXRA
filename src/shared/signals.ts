/**
 * Signal utilities shared across all webview apps.
 *
 * Re-exports from @lit-labs/signals and provides helpers
 * for extracting fields from monolithic signals.
 */

import { SignalWatcher, signal, Signal } from '@lit-labs/signals';
import { Effect, Fiber, Stream, type ManagedRuntime } from 'effect';

export { SignalWatcher, Signal };

/** A signal fed by an Effect stream, with the fiber's interrupt. */
export type StreamSignal<A> = Signal.State<A> & { dispose: () => void };

/**
 * The one meeting point between Effect and the components (PRD
 * one-fold-three-renderers, 7.5): a stream drained into a signal on the
 * given runtime, coalesced here by taking the last element of each drained
 * array. Components are `SignalWatcher`s; nothing else of Effect reaches
 * them. `dispose` interrupts the drain.
 */
export function toSignal<A>(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  changes: Stream.Stream<A>,
  initial: A,
): StreamSignal<A> {
  const s = signal(initial);
  const fiber = runtime.runFork(
    Stream.runForEachArray(changes, (arr) =>
      Effect.sync(() => {
        s.set(arr.at(-1) as A);
      }),
    ),
  );
  return Object.assign(s, {
    dispose: () => {
      runtime.runFork(Fiber.interrupt(fiber));
    },
  });
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
      // Re-arm in `finally`: a Watcher fires once and stays dormant until
      // `watch()` runs again, so letting a throw from a pending getter or
      // `notify()` skip it silently kills this subscription for the rest of the
      // process. For a React subscriber that means a component frozen on stale
      // data with no error and no recovery.
      try {
        // Read every pending computed so the watcher re-tracks its dependencies.
        // A watched `Signal.State` never reports pending, so this is a no-op for
        // subscribers that watch state signals directly.
        for (const pending of watcher.getPending()) pending.get();
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
