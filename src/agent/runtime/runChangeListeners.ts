/**
 * The change waiters of one session's runs.
 *
 * A waiter is not a record of a live run — `executions wait` registers one for
 * a run this process may never hold — so the waiters are keyed apart from the
 * roster's entries and never create one.
 */

import { Effect } from 'effect';

import type { RunId } from '@shared/schemas';
import type { RunHandle } from './RunHandle';

export class RunChangeListeners {
  private readonly listeners = new Map<
    RunId,
    Set<(handle: RunHandle | undefined) => void>
  >();

  /**
   * Register a change waiter for `runId` and return its disposer.
   *
   * The full wake set, which is what an `executions wait` observes:
   *
   * - a status transition on this run;
   * - a `track`, including a *replacement* handle for the same id (a resumed
   *   generation taking over from its predecessor) — a `track` that skipped
   *   this would strand a waiter across a resume;
   * - an `untrack`, including for an id that holds no handle;
   * - a `kill`, unconditionally, even when no live interrupt target was
   *   reached;
   * - session disposal, for every run still tracked at teardown.
   *
   * The only caller is {@link waitForAnyChange}, which detaches inside the
   * callback. The callback receives the current handle, or `undefined` once
   * the run was untracked or the session disposed.
   */
  private add(
    runId: RunId,
    cb: (handle: RunHandle | undefined) => void,
  ): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(runId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.listeners.delete(runId);
    };
  }

  /** Wake the waiters on `runId` with the run's current handle, if any. */
  notify(runId: RunId, handle: RunHandle | undefined): void {
    const listeners = this.listeners.get(runId);
    if (!listeners) return;
    // Iterate a snapshot so a listener disposing itself mid-fire is safe.
    for (const cb of [...listeners]) cb(handle);
  }

  /**
   * Wait for any of the given runs to change — see {@link add} for the full
   * wake set — and succeed with the run id that changed first.
   *
   * A caller that wants a bounded wait races or times out this effect instead
   * of passing a deadline in: interrupting the waiting fiber is what detaches
   * the listeners, so an abandoned wait leaves nothing registered.
   */
  waitForAnyChange(runIds: readonly RunId[]): Effect.Effect<RunId> {
    return Effect.callback<RunId>((resume) => {
      let resolved = false;
      const detachListeners: Array<() => void> = [];
      const cleanup = (): void => {
        for (const detach of detachListeners) detach();
      };

      for (const id of runIds) {
        detachListeners.push(
          this.add(id, () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resume(Effect.succeed(id));
          }),
        );
      }

      return Effect.sync(cleanup);
    });
  }

  clear(): void {
    this.listeners.clear();
  }
}
