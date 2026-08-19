// React bridge for `@lit-labs/signals` via `useSyncExternalStore`. Mirrors
// the primitive the webview's `progressState` uses so the CLI host can read
// the same signals without pulling in a second state-management library.

import { useCallback, useSyncExternalStore } from 'react';

import { subscribeToSignalChanges } from '@shared/signals';
import type { Signal } from '@lit-labs/signals';

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
 *
 * A change notification is already queued in the microtask above when the
 * component unmounts (or, under React StrictMode's dev-mode mount/cleanup/
 * remount, when this particular subscription is torn down): the cleanup
 * below only calls `watcher.unwatch(signal)`, so without a disposed guard
 * the pending microtask would still fire `notify()` on an unmounted
 * subscriber and re-arm the watcher via `watcher.watch()`, leaking it.
 * `disposed` is scoped to this one `subscribe()` invocation, so StrictMode's
 * remount creates a fresh watcher/flag pair rather than sharing state with
 * the torn-down one.
 */
export function useSignal<T>(signal: ReadableSignal<T>): T {
  const subscribe = useCallback(
    (notify: () => void) => subscribeToSignalChanges([signal], notify),
    [signal],
  );
  return useSyncExternalStore(subscribe, () => signal.get());
}
