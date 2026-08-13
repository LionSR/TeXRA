// Shared "did this unmount / re-run before my async work finished?" guard.
// Every async `useEffect` in the TUI needs to drop state updates that resolve
// after the effect's cleanup has already run; that boilerplate (a `cancelled`
// flag set in the cleanup, read from the async continuation) was previously
// hand-rolled at each call site. `useCancellableEffect` centralizes it.

import { useEffect } from 'react';

type IsEffectCancelled = () => boolean;

/**
 * Runs `effect` like a normal `useEffect`, but passes it an `isCancelled()`
 * check the effect can poll before applying async state updates after
 * unmount or a dependency change. `effect` may itself be async (its returned
 * promise is not awaited) and may optionally return its own cleanup
 * function, mirroring the real `useEffect` contract.
 */
export function useCancellableEffect(
  effect: (
    isCancelled: IsEffectCancelled,
  ) => void | Promise<void> | (() => void),
  deps: React.DependencyList,
): void {
  useEffect(() => {
    let cancelled = false;
    const cleanup = effect(() => cancelled);
    return () => {
      cancelled = true;
      if (typeof cleanup === 'function') cleanup();
    };
  }, deps);
}
