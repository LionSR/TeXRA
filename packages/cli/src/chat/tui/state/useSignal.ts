// React bridge for `@lit-labs/signals` via `useSyncExternalStore`. Mirrors
// the primitive the webview's `progressState` uses so the CLI host can read
// the same signals without pulling in a second state-management library.

import { useCallback, useSyncExternalStore } from 'react';
import { Signal } from '@lit-labs/signals';

type ReadableSignal<T> = Signal.State<T> | Signal.Computed<T>;

/**
 * Subscribe a React component to a `@lit-labs/signals` state/computed signal.
 *
 * `Signal.subtle.Watcher` fires exactly once per change and must be re-armed
 * in the notify callback — the wrapper does that here so consumers see every
 * update.
 *
 * The notify callback runs synchronously inside the producer's own `.set()`
 * call, while the signal graph is still in its "notification phase" —
 * `Signal.subtle.Watcher`'s documented constraint is that no signal read may
 * recompute a `Computed` during that phase. `useSyncExternalStore` can call
 * our `getSnapshot` (`signal.get()`) synchronously from within `notify()`
 * (React's `checkIfSnapshotChanged`), so a watched `Signal.Computed` whose
 * dependency just changed would recompute — and read further signals — still
 * inside that phase, tripping the polyfill's assertion. `@lit-labs/signals`'s
 * own `SignalWatcher` mixin avoids this by deferring every notify to a
 * microtask (see its `effectWatcher`); we do the same here so `getSnapshot`
 * only ever runs once the triggering `.set()` call has fully unwound.
 *
 * The subscribe callback is memoized per signal: `useSyncExternalStore`
 * unsubscribes and resubscribes whenever the subscribe reference changes, so
 * an inline closure would tear down and rebuild the Watcher on every render
 * — per signal, per component, at streaming cadence.
 */
export function useSignal<T>(signal: ReadableSignal<T>): T {
  const subscribe = useCallback(
    (notify: () => void) => {
      let notifyPending = false;
      const watcher = new Signal.subtle.Watcher(() => {
        if (notifyPending) return;
        notifyPending = true;
        queueMicrotask(() => {
          notifyPending = false;
          notify();
          watcher.watch();
        });
      });
      watcher.watch(signal);
      return () => watcher.unwatch(signal);
    },
    [signal],
  );
  return useSyncExternalStore(subscribe, () => signal.get());
}
