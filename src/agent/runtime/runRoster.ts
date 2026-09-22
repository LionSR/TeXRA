/**
 * What this process holds for a run, in one entry per run.
 *
 * One roster per session is the single in-process authority for "is a
 * generation of this run live here" ({@link RunRoster.isLive}, the one
 * admission): the tracked handle, the native child loop's activation, the
 * the run's serial lifecycle lane and
 * the generations holding it are fields of one entry, so admission, stop and
 * deletion all answer from the same record. The registry (`runRegistry.ts`)
 * owns the session-facing surface, the stopper (`runStopping.ts`) what a stop
 * does with these records.
 *
 * Serialization itself is `withPerKeyLane` (`@utils/core/perKeyQueue`): a
 * `Deferred` hand-off chain rather than a queue, which gives FIFO admission
 * for free and keeps the wait interruptible — a caller interrupted while
 * queued hands its successor the wait for whoever holds the lane, rather than
 * leaving a task behind in a queue nobody can reach. The lane lives on the
 * entry, so the helper's map is this roster's own.
 */

import { Data, Deferred, Effect, type Scope } from 'effect';

import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { RunChangeListeners } from './runChangeListeners';
import type { RunHandle } from './RunHandle';
import type { ChildRunActivation } from './runRegistryTypes';

/** A generation, a hold or a retained owner already has the run here: the one
 *  refusal for that fact. Hosts word it from `message`; a resume reads the tag
 *  to report the run unresumable, not failed. */
export class RunLive extends Data.TaggedError('RunLive')<{
  readonly runId: string;
}> {
  override get message(): string {
    return `Run is already running: ${this.runId}`;
  }
}

/** Everything this process holds for one run. The entry exists exactly while
 *  one of its fields does, which is what makes it the liveness authority. */
interface RunEntry {
  handle?: RunHandle;
  activation?: ChildRunActivation;
  /** The run's hand-off chain while a fiber holds or waits on it. */
  lane?: PerKeyLane;
  /** Generations of this run holding or waiting on that lane; an inactive-run
   *  step takes the lane without being one ({@link RunRoster.isLive}). */
  launches: number;
  /** The completion of every generation of this run a caller is holding
   *  against local ownership — a set rather than one chained value, because
   *  they end in no fixed order. */
  readonly generations: Set<Deferred.Deferred<void>>;
}

export class RunRoster {
  private readonly entries = new Map<RunId, RunEntry>();
  private readonly listeners = new RunChangeListeners();
  /** The stops begun for each run ({@link beginStop}), one token apiece: the
   *  run admits no new child until every one has settled ({@link throughStop})
   *  or a new generation takes the lane. Two overlapping stops of one parent
   *  each hold the gate they opened, so the first to settle cannot admit a
   *  child the second's snapshot has already left behind. */
  private readonly stopping = new Map<RunId, Set<symbol>>();
  /** Steps admitted but not yet started, across every run: session disposal
   *  fails all of them at once, so they need no per-run keying. */
  private readonly waiting = new Set<Deferred.Deferred<never, Error>>();
  /** The lane slots `withPerKeyLane` reads and writes: this roster's entries,
   *  so a lane is never a record of a run the entry map does not have. */
  private readonly lanes = {
    get: (runId: RunId) => this.entries.get(runId)?.lane,
    set: (runId: RunId, lane: PerKeyLane) => {
      this.entryFor(runId).lane = lane;
    },
    delete: (runId: RunId) => {
      const entry = this.entries.get(runId);
      if (!entry) return;
      entry.lane = undefined;
      this.prune(runId, entry);
    },
  };

  constructor(private readonly approvals: SessionApprovals) {}

  private entryFor(runId: RunId): RunEntry {
    const existing = this.entries.get(runId);
    if (existing) return existing;
    const entry: RunEntry = { generations: new Set(), launches: 0 };
    this.entries.set(runId, entry);
    return entry;
  }

  /** Drop an entry that records nothing: the run is not here any more. */
  private prune(runId: RunId, entry: RunEntry): void {
    if (entry.handle ?? entry.activation ?? entry.lane) return;
    if (entry.launches > 0 || entry.generations.size > 0) return;
    if (this.entries.get(runId) === entry) {
      this.entries.delete(runId);
      this.notifyWaiters(runId);
    }
  }

  // ---------------------------------------------------------------- handles

  handle(runId: RunId): RunHandle | undefined {
    return this.entries.get(runId)?.handle;
  }

  allHandles(): RunHandle[] {
    const handles: RunHandle[] = [];
    for (const entry of this.entries.values())
      if (entry.handle) handles.push(entry.handle);
    return handles;
  }

  setHandle(handle: RunHandle): void {
    this.entryFor(handle.runId).handle = handle;
  }

  /** Remove a run handle and notify waiters; a run with no handle still
   *  wakes its waiters, since the call is the change they wait on. */
  deleteHandle(runId: RunId): void {
    const entry = this.entries.get(runId);
    if (entry) {
      entry.handle = undefined;
      this.prune(runId, entry);
    }
    this.notifyWaiters(runId);
  }

  /** Remove `handle` only if it is still the current registration. */
  deleteHandleIfCurrent(handle: RunHandle): boolean {
    if (this.handle(handle.runId) !== handle) return false;
    this.deleteHandle(handle.runId);
    return true;
  }

  // ------------------------------------------------------- child activations

  activation(runId: RunId): ChildRunActivation | undefined {
    return this.entries.get(runId)?.activation;
  }

  /** Retain a native child loop's lineage. */
  addActivation(activation: ChildRunActivation): void {
    this.entryFor(activation.runId).activation = activation;
  }

  removeActivation(runId: RunId, expected: ChildRunActivation): void {
    const entry = this.entries.get(runId);
    if (entry?.activation !== expected) return;
    entry.activation = undefined;
    this.prune(runId, entry);
    // The loop's last record is gone: a waiter on its settlement wakes.
    this.notifyWaiters(runId);
  }

  *activeChildActivations(parentRunId: RunId): Generator<ChildRunActivation> {
    for (const entry of this.entries.values()) {
      const activation = entry.activation;
      if (
        activation !== undefined &&
        activation.parentRunId === parentRunId &&
        !activation.isDetached()
      ) {
        yield activation;
      }
    }
  }

  /** The children one parent's detach covers. A Set, not an array: a child
   *  detached mid-turn has both a live handle and a ChildRunActivation
   *  under one runId, so both loops reach it and it is severed once. */
  childRunIds(parentRunId: RunId): readonly RunId[] {
    const childRunIds = new Set<RunId>();
    for (const activation of this.activeChildActivations(parentRunId))
      childRunIds.add(activation.runId);
    for (const handle of this.allHandles())
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
      const entry = this.entries.get(childRunId);
      const activation = entry?.activation;
      if (activation?.parentRunId === parentRunId) activation.detach();
      this.approvals.detachRunFromParent(childRunId);
      const handle = entry?.handle;
      if (handle?.isOwnedBy(parentRunId) === true) handle.detach();
    }
  }

  /** Whether any fiber holds or waits on `runId`'s lane, step or generation. */
  private isLaneOccupied(runId: RunId): boolean {
    return (this.entries.get(runId)?.lane?.fibers ?? 0) > 0;
  }

  /** A handle or a child activation this session still retains for `runId`. */
  private isRetained(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    return entry?.handle !== undefined || entry?.activation !== undefined;
  }

  /** Whether a child may be admitted under `parentRunId` now. A begun stop of
   *  the parent refuses a new child ({@link beginStop}); a child this roster
   *  already holds is not a new admission — a native child's activation and
   *  its live handles re-enter while the detach runs. */
  admitsChild(parentRunId: RunId, childRunId: RunId): boolean {
    return !this.isStopping(parentRunId) || this.isRetained(childRunId);
  }

  /** Runs with a live interrupt target: tracked handles and native child
   *  activations. A lane still releasing resources can outlive both; the
   *  drain waits for its entry without trying to stop it again. */
  activeIds(): RunId[] {
    const ids: RunId[] = [];
    for (const [runId, entry] of this.entries)
      if (entry.handle !== undefined || entry.activation !== undefined)
        ids.push(runId);
    return ids;
  }

  // ----------------------------------------------------------------- parking

  /** Whether this process holds a live generation of the run. */
  isLive(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined) return false;
    if (entry.generations.size > 0 || entry.launches > 0) return true;
    return entry.handle?.getToolUseFlow() !== undefined;
  }

  /** Run `operation` on `runId`'s lane: claim the lane synchronously, wait for
   *  the predecessor and then for the live generations, and hold the lane
   *  until `operation` settles — including the finalizers it registered, since
   *  `withPerKeyLane` releases the lane only once the whole effect leaves.
   *
   *  The claim is conditional and `withPerKeyLane` runs the condition: {@link
   *  isLive} reads the entry in the same synchronous step as the tail swap, so
   *  no generation can take the run between the two, and refusing leaves the
   *  lane as it was found. This is the one admission, so no caller asks it
   *  beforehand. `refuseWhenLive` marks the caller an inactive-run step rather
   *  than a generation: it widens the refusal to the retained owners and to
   *  whoever else holds the lane, and keeps the step out of {@link isLive}, so
   *  the run's next generation queues behind it.
   *
   *  A step is refusable from admission until it starts, and {@link waiting}
   *  holds its refusal for exactly that window. The race is therefore around
   *  the lane, not inside it: a step still waiting for its predecessor is
   *  refused where it stands, and hands the lane on when interrupted. */
  launch<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
    refuseWhenLive = false,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      const refusal = Deferred.makeUnsafe<never, Error>();
      this.waiting.add(refusal);
      // Counted in where the generation claims the lane, out where the step leaves; the entry is captured at the claim, so a stale leave unwinding after `clear` decrements its own entry.
      let counted: RunEntry | undefined;
      const refuseClaim = (): RunLive | undefined => {
        const held =
          refuseWhenLive &&
          (this.isRetained(runId) || this.isLaneOccupied(runId));
        if (this.isLive(runId) || held) return new RunLive({ runId });
        if (refuseWhenLive) return undefined;
        this.clearStops(runId);
        counted = this.entryFor(runId);
        counted.launches += 1;
        return undefined;
      };
      const leave = (): void => {
        this.waiting.delete(refusal);
        const entry = counted;
        counted = undefined;
        if (entry === undefined) return;
        entry.launches -= 1;
        this.prune(runId, entry);
      };
      const step = Effect.gen({ self: this }, function* () {
        // Read the gate after the predecessor left: a generation it started
        // is exactly what this step must not overlap. One snapshot, as the
        // predecessor's own wait took one — a generation opened after this
        // read belongs to the step that opened it, not to this one.
        const generations = this.entries.get(runId)?.generations;
        if (generations !== undefined && generations.size > 0) {
          yield* Effect.all(
            [...generations].map((generation) => Deferred.await(generation)),
            { concurrency: 'unbounded', discard: true },
          );
        }
        this.waiting.delete(refusal);
        return yield* operation;
      });
      return Effect.raceFirst(
        Deferred.await(refusal),
        withPerKeyLane(this.lanes, runId, refuseClaim)(step),
      ).pipe(Effect.ensuring(Effect.sync(leave)));
    });
  }

  /** Hold `runId` against local ownership for the caller's scope, refusing
   *  when a generation, a step on its lane, or a retained handle owns it here
   *  — an inactive-run step's refusal ({@link launch}), for a decision whose
   *  validity has to outlive the step that took it. The hold is a generation
   *  like any other: {@link isLive} reports it, so a resume refuses on it, a
   *  launch of the same run waits for it, and a competing step is refused. */
  holdInactive(runId: RunId): Effect.Effect<void, RunLive, Scope.Scope> {
    return Effect.asVoid(
      Effect.acquireRelease(
        // The test and the registration are one synchronous step, as the
        // conditional lane claim is: nothing can take the run in between.
        Effect.suspend(() =>
          this.isLive(runId) ||
          this.isRetained(runId) ||
          this.isLaneOccupied(runId)
            ? Effect.fail(new RunLive({ runId }))
            : Effect.sync(() => this.openGeneration(runId)),
        ),
        (close) => Effect.sync(close),
      ),
    );
  }

  /** Register a live generation of `runId` and hand back its close: synchronous
   *  with the call, idempotent against a disposal that dropped the entry. */
  private openGeneration(runId: RunId): () => void {
    const completion = Deferred.makeUnsafe<void>();
    const entry = this.entryFor(runId);
    entry.generations.add(completion);
    return () => {
      Deferred.doneUnsafe(completion, Effect.void);
      entry.generations.delete(completion);
      this.prune(runId, entry);
    };
  }

  // --------------------------------------------------------------- waiters

  notifyWaiters(runId: RunId): void {
    this.listeners.notify(runId, this.handle(runId));
  }

  /** Wait for any of these runs to change; succeeds with the first to. */
  waitForAnyChange(runIds: readonly RunId[]): Effect.Effect<RunId> {
    return this.listeners.waitForAnyChange(runIds);
  }

  /** Resolve once every owner has left: handles, child activations, lanes and
   *  scoped holds. Terminal handle removal can precede a lane's final writes.
   *  Interrupting the waiting fiber — what a close budget does — detaches the
   *  listeners with it. The re-check arm is load-bearing: `raceAllFirst`
   *  starts its arms in order, so the wait registers first and the re-check
   *  then sees a last run that left between the read above and those
   *  listeners, rather than waiting out the close budget for a notification
   *  that can no longer come. */
  awaitDrained(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const active = [...this.entries.keys()];
        if (active.length === 0) return;
        yield* Effect.raceAllFirst([
          this.waitForAnyChange(active).pipe(Effect.asVoid),
          Effect.suspend(() =>
            this.entries.size === 0 ? Effect.void : Effect.never,
          ),
        ]);
      }
    });
  }

  // ------------------------------------------------------------------ gates

  /** Mark a run's stop as begun, synchronously, before the stop reads which
   *  children it has to detach. A detaching stop snapshots the parent's
   *  children, commits their `run.detach` batch, severs them locally, and only
   *  then interrupts the parent — deliberately without cascading. A child
   *  admitted while that commit is in flight would be in neither the durable
   *  nor the local sever, and would still resolve the just-stopped parent as
   *  its delivery target. The mark closes that window at its start: from here
   *  until the stop settles, no new child is admitted under it ({@link
   *  admitsChild}), and a cascading stop takes the same mark. The mark is the
   *  stop's, so {@link throughStop} owns its whole life: a multi-turn parent
   *  tracking its next turn's handle mid-detach is not the stop ending, and a
   *  run whose next generation takes the lane has left it. */
  beginStop(runId: RunId): symbol {
    const token = Symbol('run-stop');
    const tokens = this.stopping.get(runId) ?? new Set<symbol>();
    tokens.add(token);
    this.stopping.set(runId, tokens);
    return token;
  }

  /** End this stop's admission gate when its settlement does, succeeded or
   *  failed: a refused `run.detach` commit never reaches the interrupt, so the
   *  parent generation it marked still runs and still owns the children it
   *  launches next. The gate lifts when the last stop lets go, since an
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

  // --------------------------------------------------------------- teardown

  /** Drop every local record at session disposal, refuse every step admitted
   *  but not started, and wake the waiters on the runs that held a handle.
   *  Parked fibers are interrupted where they wait: the session is gone, so no
   *  terminal row of theirs is this process's to write. */
  clear(disposal: Error): void {
    for (const refusal of this.waiting) {
      Deferred.doneUnsafe(refusal, Effect.fail(disposal));
    }
    this.waiting.clear();
    const tracked = [...this.entries.keys()];
    this.entries.clear();
    for (const runId of tracked) this.notifyWaiters(runId);
    this.stopping.clear();
    this.listeners.clear();
  }
}
