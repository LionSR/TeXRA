// React bridge for `@lit-labs/signals` via `useSyncExternalStore`. Mirrors
// the primitive the webview's `progressState` uses so the CLI host can read
// the same signals without pulling in a second state-management library.

import { useSyncExternalStore } from 'react';
import { Signal } from '@lit-labs/signals';

type ReadableSignal<T> = Signal.State<T> | Signal.Computed<T>;

/**
 * Subscribe a React component to a `@lit-labs/signals` state/computed signal.
 *
 * `Signal.subtle.Watcher` fires exactly once per change and must be re-armed
 * in the notify callback — the wrapper does that here so consumers see every
 * update.
 */
export function useSignal<T>(signal: ReadableSignal<T>): T {
  return useSyncExternalStore(
    (notify) => {
      const watcher = new Signal.subtle.Watcher(() => {
        notify();
        watcher.watch();
      });
      watcher.watch(signal);
      return () => watcher.unwatch(signal);
    },
    () => signal.get(),
  );
}
