/**
 * What this process holds for a run.
 *
 * One roster per session records every local record of a run — the tracked
 * handle, the native child loop's activation, the fiber a WAITING generation
 * parked on — together with the change waiters that read them and the stop
 * and detach gates that fence an admission while a stop is in flight. The
 * registry (`runRegistry.ts`) owns what a stop *does*; the roster owns who is
 * here to be stopped, so "is this run live in this process" is answered in
 * one place rather than by three maps a caller has to consult in order.
 */

import { Deferred, Effect } from 'effect';

import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';
import type { RunHandle } from './RunHandle';
import type { ChildRunActivation, ParkedRun } from './runRegistryTypes';

export class RunRoster {
  private readonly handles = new Map<RunId, RunHandle>();
  private readonly childActivations = new Map<RunId, ChildRunActivation>();
  /** Every run parked at WAITING in this session. */
  private readonly parked = new Map<RunId, ParkedRun>();
  private readonly listeners = new Map<
    string,
    Set<(handle: RunHandle | undefined) => void>
  >();
  /** The stops begun for each run ({@link beginStop}), one token apiece:
   *  the run admits no new child until every one of them has settled
   *  ({@link throughStop}) or a new generation of it takes the lane. Two
   *  overlapping stops of one parent each hold the gate they opened, so the
   *  first to settle cannot admit a child the second's snapshot has already
   *  left behind. */
  private readonly stopping = new Map<RunId, Set<symbol>>();
  /** The children a detach in flight has snapshotted, each held until that
   *  detach settles ({@link throughDetach}). Its batch lands on the child's
   *  own aggregate, which takes an append from its claim holder alone, so a
   *  child that ends in this window keeps its claim until the batch has
   *  committed instead of having it refused with nothing severed. */
  private readonly detaching = new Map<RunId, Deferred.Deferred<void>>();

  constructor(private readonly approvals: SessionApprovals) {}

  // ---------------------------------------------------------------- handles

  handle(runId: RunId): RunHandle | undefined {
    return this.handles.get(runId);
  }

  allHandles(): RunHandle[] {
    return [...this.handles.values()];
  }

  setHandle(handle: RunHandle): void {
    this.handles.set(handle.runId, handle);
  }

  /** Remove a run handle and notify waiters; a run with no handle still
   *  wakes its waiters, since the call is the change they wait on. */
  deleteHandle(runId: RunId): void {
    this.handles.delete(runId);
    this.notifyWaiters(runId);
  }

  /** Remove `handle` only if it is still the current registration. */
  deleteHandleIfCurrent(handle: RunHandle): boolean {
    if (this.handles.get(handle.runId) !== handle) return false;
    this.deleteHandle(handle.runId);
    return true;
  }

  // ------------------------------------------------------- child activations

  activation(runId: RunId): ChildRunActivation | undefined {
    return this.childActivations.get(runId);
  }

  /** Retain a native child loop's lineage. Answers `false` when this run
   *  already has one, which is the caller's signal that it reserved nothing. */
  addActivation(activation: ChildRunActivation): boolean {
    if (this.childActivations.has(activation.runId)) return false;
    this.childActivations.set(activation.runId, activation);
    return true;
  }

  removeActivation(runId: RunId, expected: ChildRunActivation): void {
    if (this.childActivations.get(runId) !== expected) return;
    this.childActivations.delete(runId);
    // The loop's last record is gone: a waiter on its settlement wakes.
    this.notifyWaiters(runId);
  }

  *activeChildActivations(parentRunId: RunId): Generator<ChildRunActivation> {
    for (const activation of this.childActivations.values()) {
      if (activation.parentRunId === parentRunId && !activation.isDetached()) {
        yield activation;
      }
    }
  }

  /** The children one parent's detach covers. A Set, not an array: a child
   *  detached mid-turn has both a per-turn handle and a ChildRunActivation
   *  under one runId, so both loops reach it and it is severed once. */
  childRunIds(parentRunId: RunId): readonly RunId[] {
    const childRunIds = new Set<RunId>();
    for (const activation of this.activeChildActivations(parentRunId))
      childRunIds.add(activation.runId);
    for (const handle of this.handles.values())
      if (handle.isOwnedBy(parentRunId)) childRunIds.add(handle.runId);
    return [...childRunIds];
  }

  hasActiveChildren(parentRunId: RunId): boolean {
    return this.childRunIds(parentRunId).length > 0;
  }

  /** Apply parent removal to local handles and approval ancestry without
   *  publishing, over children a durable detach already covers. */
  detachChildren(
    parentRunId: RunId,
    childRunIds: readonly RunId[] = this.childRunIds(parentRunId),
  ): void {
    for (const childRunId of childRunIds) {
      const activation = this.childActivations.get(childRunId);
      if (activation?.parentRunId === parentRunId) activation.detach();
      this.approvals.detachRunFromParent(childRunId);
      const handle = this.handles.get(childRunId);
      if (handle?.isOwnedBy(parentRunId) === true) handle.detach();
    }
  }

  /** A handle or a child activation this session still retains for `runId`. */
  hasRetainedOwner(runId: RunId): boolean {
    return this.handles.has(runId) || this.childActivations.has(runId);
  }

  /**
   * Every run live in this session: the tracked handles and the native child
   * loops retained between turns, whose activation is the only record of them.
   * This is what a close stops and waits on, so a child with a final delivery
   * to do is never left running under a released session.
   */
  activeIds(): RunId[] {
    return [
      ...new Set([...this.handles.keys(), ...this.childActivations.keys()]),
    ];
  }

  // ----------------------------------------------------------------- parking

  setParked(runId: RunId, entry: ParkedRun): void {
    this.parked.set(runId, entry);
    entry.fiber.addObserver(() => {
      if (this.parked.get(runId) === entry) this.parked.delete(runId);
    });
  }

  parkedRun(runId: RunId): ParkedRun | undefined {
    return this.parked.get(runId);
  }

  isParked(runId: RunId): boolean {
    return this.parked.has(runId);
  }

  /** Drop the park entry for `runId` and hand it back, so the caller decides
   *  whether the fiber is interrupted (a resume) or woken (a stop). */
  takeParked(runId: RunId): ParkedRun | undefined {
    const entry = this.parked.get(runId);
    if (entry) this.parked.delete(runId);
    return entry;
  }

  // --------------------------------------------------------------- waiters

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
   * Private: the only caller is {@link waitForAnyChange}, which detaches
   * inside the callback. The callback receives the current handle, or
   * `undefined` once the run was untracked or the session disposed.
   */
  private addListener(
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

  notifyWaiters(runId: RunId): void {
    const listeners = this.listeners.get(runId);
    if (!listeners) return;

    const handle = this.handles.get(runId);
    // Iterate a snapshot so a listener disposing itself mid-fire is safe.
    for (const cb of [...listeners]) cb(handle);
  }

  /**
   * Wait for any of the given runs to change — see {@link addListener} for
   * the full wake set — and succeed with the run id that changed first.
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
          this.addListener(id, () => {
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

  /**
   * Resolve once every run this roster holds has left it: the drain a session
   * close and a project close both wait on, over {@link activeIds}.
   *
   * Interrupting the waiting fiber — which is what a close budget does —
   * detaches the listeners with it. The re-check arm is load-bearing:
   * `raceAllFirst` starts its arms in order, so the wait registers first and
   * the re-check then sees a last run that left between the read above and
   * those listeners, instead of waiting out the whole close budget for a
   * notification that can no longer come.
   */
  awaitDrained(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const active = this.activeIds();
        if (active.length === 0) return;
        yield* Effect.raceAllFirst([
          this.waitForAnyChange(active).pipe(Effect.asVoid),
          Effect.suspend(() =>
            this.activeIds().length === 0 ? Effect.void : Effect.never,
          ),
        ]);
      }
    });
  }

  // ------------------------------------------------------------------ gates

  /**
   * Mark a run's stop as begun, synchronously, before the stop reads which
   * children it has to detach.
   *
   * A detaching stop snapshots the parent's children, commits their
   * `run.detach` batch, severs them locally, and only then interrupts the
   * parent — deliberately without cascading. A child admitted while that
   * commit is in flight would be in neither the durable nor the local sever
   * and would still resolve the just-stopped parent as its delivery target.
   * The mark closes that window at its start: from here until the stop
   * settles, no new child is admitted under it.
   * A cascading stop takes the same mark for the same reason.
   *
   * The mark is the stop's, so {@link throughStop} owns its whole life: a
   * multi-turn parent tracking its next turn's handle mid-detach is not the
   * stop ending, and a run whose next generation takes the lane has left the
   * stop behind either way.
   */
  beginStop(runId: RunId): symbol {
    const token = Symbol('run-stop');
    const tokens = this.stopping.get(runId) ?? new Set<symbol>();
    tokens.add(token);
    this.stopping.set(runId, tokens);
    return token;
  }

  /** End this stop's admission gate when its settlement does, succeeded or
   *  failed: a refused `run.detach` commit never reaches the interrupt, so the
   *  parent generation it marked is still running and still owns the children
   *  it launches next. The gate lifts when the last stop lets go, since an
   *  overlapping stop is still committing over an older snapshot. */
  throughStop(
    runId: RunId,
    token: symbol,
    settlement: Effect.Effect<void, Error>,
  ): Effect.Effect<void, Error> {
    return settlement.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const tokens = this.stopping.get(runId);
          if (tokens?.delete(token) !== true) return;
          if (tokens.size === 0) this.stopping.delete(runId);
        }),
      ),
    );
  }

  /** Whether a stop of `runId` has begun and not yet settled. */
  isStopping(runId: RunId): boolean {
    return this.stopping.has(runId);
  }

  /** A new generation of `runId` is the run starting again: whatever stop the
   *  run was marked for belongs to the generation it ended. */
  clearStops(runId: RunId): void {
    this.stopping.delete(runId);
  }

  /** The wait a child's lease release takes before it drops its claim
   *  (`SessionHandle.releaseRunLease`, the one release): nothing unless a
   *  detach of its parent is in flight over it, and that detach's settlement
   *  otherwise. */
  throughDetach(runId: RunId): Effect.Effect<void> {
    const detached = this.detaching.get(runId);
    return detached === undefined ? Effect.void : Deferred.await(detached);
  }

  /** Hold every named child until `detached` completes, and hand back the
   *  release that stops holding them. */
  markDetaching(
    childRunIds: readonly RunId[],
    detached: Deferred.Deferred<void>,
  ): () => void {
    for (const childRunId of childRunIds)
      this.detaching.set(childRunId, detached);
    return () => {
      for (const childRunId of childRunIds)
        if (this.detaching.get(childRunId) === detached)
          this.detaching.delete(childRunId);
      Deferred.doneUnsafe(detached, Effect.void);
    };
  }

  // --------------------------------------------------------------- teardown

  /**
   * Drop every local record at session disposal and wake the waiters on the
   * runs that held one. Parked fibers are interrupted where they wait: the
   * session is gone, so no terminal row of theirs is this process's to write.
   */
  clear(): void {
    for (const parked of this.parked.values()) parked.fiber.interruptUnsafe();
    this.parked.clear();
    const runIds = [...this.handles.keys()];
    this.handles.clear();
    for (const runId of runIds) this.notifyWaiters(runId);
    this.childActivations.clear();
    this.stopping.clear();
    this.listeners.clear();
  }
}
