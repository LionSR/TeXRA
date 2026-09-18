import { Effect } from 'effect';

let deferDepth = 0;
let deferredWork: Array<() => Promise<void>> = [];

export function isAgentCatalogAuthRefreshDeferred(): boolean {
  return deferDepth > 0;
}

export function runAfterAgentCatalogAuthRefresh(
  work: () => Promise<void>,
): void {
  if (deferDepth === 0) {
    void work();
    return;
  }
  deferredWork.push(work);
}

/**
 * Keep auth listeners from racing the team preflight's single catalog fetch.
 *
 * The scope takes the program it guards rather than a thunk: the team apply
 * it wraps is an `Effect`, and `acquireUseRelease` holds the depth for
 * exactly the fiber's lifetime — the release runs on failure and on
 * interruption the way the `finally` it replaces ran on a rejection.
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
        return Effect.promise(() =>
          Promise.allSettled(pending.map((refresh) => refresh())),
        ).pipe(Effect.asVoid);
      }),
  );
}

export function resetAgentCatalogAuthRefreshScopeForTests(): void {
  deferDepth = 0;
  deferredWork = [];
}
