/**
 * What this process holds for a run, in one entry per run.
 *
 * One roster per session is the single in-process authority for "is a
 * generation of this run live here" ({@link RunRoster.isLive}, the one
 * admission): the tracked handle, the native child loop's activation, the
 * fiber a WAITING generation parked on, the run's serial lifecycle lane and
 * the generations holding it are fields of one entry, so admission, stop and
 * deletion all answer from the same record. The registry (`runRegistry.ts`)
 * owns the session-facing surface; the stopper (`runStopping.ts`) owns what a
 * stop does with these records.
 *
 * Serialization itself is `withPerKeyLane` (`@utils/core/perKeyQueue`): a
 * `Deferred` hand-off chain rather than a queue, which gives FIFO admission
 * for free and keeps the whole wait interruptible — a caller whose fiber is
 * interrupted while queued hands its successor the wait for whoever holds the
 * lane, instead of leaving a task behind in a queue nobody can reach. The
 * lane lives on the entry, so the helper's map is this roster's own.
 */

import { Data, Deferred, Effect, type Scope } from 'effect';

import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type { RunId } from '@shared/schemas';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { RunChangeListeners } from './runChangeListeners';
import type { RunHandle } from './RunHandle';
import type { ChildRunActivation, ParkedRun } from './runRegistryTypes';

/** A generation, a hold or a retained owner already has the run here: the one
 *  refusal for that fact, wherever it is taken. Hosts word it from `message`;
 *  a resume reads the tag to report the run unresumable, not failed. */
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
  parked?: ParkedRun;
  /** The run's hand-off chain while a fiber holds or waits on it. */
  lane?: PerKeyLane;
  /** The completion of every generation of this run a caller is holding
   *  against local ownership — a set rather than one chained value, because
   *  they end in no fixed order. */
  readonly generations: Set<Deferred.Deferred<void>>;
}

export class RunRoster {
  private readonly entries = new Map<RunId, RunEntry>();
  private readonly listeners = new RunChangeListeners();
  /** The stops begun for each run ({@link beginStop}), one token apiece:
   *  the run admits no new child until every one of them has settled
   *  ({@link throughStop}) or a new generation of it takes the lane. Two
   *  overlapping stops of one parent each hold the gate they opened, so the
   *  first to settle cannot admit a child the second's snapshot has already
   *  left behind. */
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
    const entry: RunEntry = { generations: new Set() };
    this.entries.set(runId, entry);
    return entry;
  }

  /** Drop an entry that records nothing: the run is not here any more. */
  private prune(runId: RunId, entry: RunEntry): void {
    if (
      entry.handle !== undefined ||
      entry.activation !== undefined ||
      entry.parked !== undefined ||
      entry.lane !== undefined ||
      entry.generations.size > 0
    ) {
      return;
    }
    if (this.entries.get(runId) === entry) this.entries.delete(runId);
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
   *  detached mid-turn has both a per-turn handle and a ChildRunActivation
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

  /** A handle or a child activation this session still retains for `runId`. */
  private isRetained(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    return entry?.handle !== undefined || entry?.activation !== undefined;
  }

  /** Whether a child may be admitted under `parentRunId` now. A stop of the
   *  parent that has begun refuses a new child ({@link beginStop}); a child
   *  this roster already holds is not a new admission — a native child's
   *  activation and its turn handles re-enter while the detach runs. */
  admitsChild(parentRunId: RunId, childRunId: RunId): boolean {
    return !this.isStopping(parentRunId) || this.isRetained(childRunId);
  }

  /** Every run live in this session: the tracked handles and the native child
   *  loops retained between turns, whose activation is the only record of
   *  them. What a close stops and waits on, so a child with a final delivery
   *  to do is never left running under a released session. */
  activeIds(): RunId[] {
    const ids: RunId[] = [];
    for (const [runId, entry] of this.entries)
      if (entry.handle !== undefined || entry.activation !== undefined)
        ids.push(runId);
    return ids;
  }

  // ----------------------------------------------------------------- parking

  setParked(runId: RunId, parked: ParkedRun): void {
    this.entryFor(runId).parked = parked;
    parked.fiber.addObserver(() => {
      const entry = this.entries.get(runId);
      if (entry?.parked !== parked) return;
      entry.parked = undefined;
      this.prune(runId, entry);
    });
  }

  parkedRun(runId: RunId): ParkedRun | undefined {
    return this.entries.get(runId)?.parked;
  }

  isParked(runId: RunId): boolean {
    return this.entries.get(runId)?.parked !== undefined;
  }

  /** Drop the park record for `runId` and hand it back, so the caller decides
   *  whether the fiber is interrupted (a resume) or woken (a stop). */
  takeParked(runId: RunId): ParkedRun | undefined {
    const entry = this.entries.get(runId);
    const parked = entry?.parked;
    if (entry && parked) {
      entry.parked = undefined;
      this.prune(runId, entry);
    }
    return parked;
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Whether a generation of `runId` is live in this process, read off the one
   * entry: a step holding or waiting on its lane, a generation still
   * unwinding, a caller holding it against local ownership
   * ({@link holdInactive}), or a turn whose tool-use flow is still attached.
   * A second generation is refused on it rather than queued on the run lane.
   * A parked turn is none of them until a stop wakes it: a resume supersedes
   * the fiber where it waits, but a woken park is the run unwinding, still
   * owing its terminal row and its claim. Local ownership, never the durable
   * phase: a crash leaves the phase RUNNING, and an orphaned run in that
   * phase is what a resume takes over.
   */
  isLive(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined) return false;
    if (entry.generations.size > 0) return true;
    if ((entry.lane?.fibers ?? 0) > 0) return true;
    if (entry.parked !== undefined)
      return Deferred.isDoneUnsafe(entry.parked.stopped);
    return entry.handle?.getToolUseFlow() !== undefined;
  }

  /**
   * Run `operation` on `runId`'s lane: claim the lane synchronously, wait for
   * the predecessor and then for the live generations, and hold the lane
   * until `operation` settles — including the finalizers it registered, since
   * `withPerKeyLane` releases the lane only once the whole effect leaves.
   *
   * The claim is conditional and `withPerKeyLane` runs the condition:
   * {@link isLive} reads the entry in the same synchronous step as the tail
   * swap, so no generation can take the run between the two, and refusing
   * leaves the lane as it was found. This is the one admission, so no caller
   * asks it beforehand. `refuseWhenLive` widens it to the retained owners,
   * for callers that mean "only if nothing holds it at all".
   *
   * A step is refusable from the moment it is admitted until it starts, and
   * {@link waiting} holds its refusal for exactly that window. The race is
   * therefore around the lane, not inside it: a step still waiting for its
   * predecessor is refused where it stands, and its interruption hands the
   * lane on the way any other interrupted waiter does.
   */
  launch<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
    refuseWhenLive = false,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      const refusal = Deferred.makeUnsafe<never, Error>();
      this.waiting.add(refusal);
      const refuseClaim = (): RunLive | undefined =>
        this.isLive(runId) || (refuseWhenLive && this.isRetained(runId))
          ? new RunLive({ runId })
          : undefined;
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
      ).pipe(Effect.ensuring(Effect.sync(() => this.waiting.delete(refusal))));
    });
  }

  /**
   * Hold `runId` against local ownership for the caller's scope, refusing
   * when a generation, a step, or a retained handle already owns it here —
   * {@link launch}'s refusal, for a decision whose validity has to outlive
   * the step that took it. The hold is a generation like any other:
   * {@link isLive} reports it, so a resume refuses on it, a launch of the
   * same run waits for it, and a competing step is refused.
   */
  holdInactive(runId: RunId): Effect.Effect<void, RunLive, Scope.Scope> {
    return Effect.asVoid(
      Effect.acquireRelease(
        // The test and the registration are one synchronous step, as the
        // conditional lane claim is: nothing can take the run in between.
        Effect.suspend(() =>
          this.isLive(runId) || this.isRetained(runId)
            ? Effect.fail(new RunLive({ runId }))
            : Effect.sync(() => this.openGeneration(runId)),
        ),
        (close) => Effect.sync(close),
      ),
    );
  }

  /** Register a live generation of `runId` and hand back its close. The
   *  registration is synchronous with the call, and the close is idempotent
   *  against a disposal that dropped the entry underneath it. */
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

  /** Wait for any of the given runs to change and succeed with the run id
   *  that changed first. */
  waitForAnyChange(runIds: readonly RunId[]): Effect.Effect<RunId> {
    return this.listeners.waitForAnyChange(runIds);
  }

  /**
   * Resolve once every run this roster holds has left it: the drain a session
   * close and a project close both wait on, over {@link activeIds}.
   *
   * Interrupting the waiting fiber — which is what a close budget does —
   * detaches the listeners with it. The re-check arm is load-bearing:
   * `raceAllFirst` starts its arms in order, so the wait registers first and
   * the re-check then sees a last run that left between the read above and
   * those listeners, instead of waiting out the close budget for a
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
   * settles, no new child is admitted under it ({@link admitsChild}). A
   * cascading stop takes the same mark for the same reason.
   *
   * The mark is the stop's, so {@link throughStop} owns its whole life: a
   * multi-turn parent tracking its next turn's handle mid-detach is not the
   * stop ending, and a run whose next generation takes the lane has left it.
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

  // --------------------------------------------------------------- teardown

  /**
   * Drop every local record at session disposal, refuse every step admitted
   * but not yet started, and wake the waiters on the runs that held a handle.
   * Parked fibers are interrupted where they wait: the session is gone, so no
   * terminal row of theirs is this process's to write.
   */
  clear(disposal: Error): void {
    for (const refusal of this.waiting) {
      Deferred.doneUnsafe(refusal, Effect.fail(disposal));
    }
    this.waiting.clear();
    const tracked: RunId[] = [];
    for (const [runId, entry] of this.entries) {
      entry.parked?.fiber.interruptUnsafe();
      if (entry.handle !== undefined) tracked.push(runId);
    }
    this.entries.clear();
    for (const runId of tracked) this.notifyWaiters(runId);
    this.stopping.clear();
    this.listeners.clear();
  }
}
