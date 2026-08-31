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
 * `subscribeToSignalChanges` owns deferred notification, watcher re-arming,
 * and disposal so `useSyncExternalStore` reads snapshots only after the
 * producer's `.set()` has unwound.
 *
 * The subscribe callback is memoized per signal: `useSyncExternalStore`
 * unsubscribes and resubscribes whenever the subscribe reference changes, so
 * an inline closure would tear down and rebuild the Watcher on every render
 * — per signal, per component, at streaming cadence.
 */
export function useSignal<T>(signal: ReadableSignal<T>): T {
  const subscribe = useCallback(
    (notify: () => void) => subscribeToSignalChanges([signal], notify),
    [signal],
  );
  return useSyncExternalStore(subscribe, () => signal.get());
}
