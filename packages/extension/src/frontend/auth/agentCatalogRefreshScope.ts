import { Effect } from 'effect';

import {
  type ProcessRuntime,
  type ProcessServices,
  withProcessServices,
} from '@platform/processRuntime';
import { allSettledVoid } from '@utils/core/allSettledVoid';

let deferDepth = 0;
let deferredWork: Array<Effect.Effect<void>> = [];

export function isAgentCatalogAuthRefreshDeferred(): boolean {
  return deferDepth > 0;
}

/** Repaint `work` on `runtime` once the preflight below releases the scope. */
export function runAfterAgentCatalogAuthRefresh(
  runtime: ProcessRuntime,
  work: readonly Effect.Effect<void, Error, ProcessServices>[],
): void {
  // Every repaint runs to completion, and one that fails takes down neither
  // its siblings nor the preflight that released it — but it is logged here
  // rather than dropped.
  const program = withProcessServices(runtime, allSettledVoid(work)).pipe(
    Effect.catchCause((cause) =>
      Effect.logError('Agent catalog auth refresh failed', cause),
    ),
  );
  if (deferDepth === 0) {
    runtime.runFork(program);
    return;
  }
  deferredWork.push(program);
}

/**
 * Keep auth listeners from racing the team preflight's single catalog fetch.
 *
 * The scope takes the program it guards rather than a thunk: the team apply
 * it wraps is an `Effect`, and `acquireUseRelease` holds the depth for
 * exactly the fiber's lifetime — the release runs on failure and on
 * interruption the way the `finally` it replaces ran on a rejection. What it
 * queues is an `Effect` for the same reason, so the release fans the queue
 * out as programs instead of settling promises.
 */
export function withAgentCatalogAuthRefreshDeferred<A, E, R>(
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      deferDepth += 1;
    }),
    () => work,
    () =>
      Effect.suspend(() => {
        deferDepth -= 1;
        if (deferDepth !== 0) return Effect.void;
        const pending = deferredWork;
        deferredWork = [];
        return allSettledVoid(pending);
      }),
  );
}

export function resetAgentCatalogAuthRefreshScopeForTests(): void {
  deferDepth = 0;
  deferredWork = [];
}
