/**
 * Handle-based run registry.
 *
 * Manages agent run handles and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import { Context, Deferred, Effect, Fiber, Semaphore, type Scope } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type {
  FinalizeRunInput,
  FinalizeRunResult,
} from '@agent/storage/runLifecycle';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  type SessionEventDraft,
  type RunPhase,
} from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';
import { formatDuration } from '@utils/text/stringUtils';
import {
  type RunHandle,
  type RunStatusInfo,
  type LiveToolUseFlowContext,
} from './RunHandle';
import { RunLanes } from './runLanes';

/**
 * Child policy shared by `kill()` and `stopAgentRun()`. The caller owns the
 * decision because only it knows which gesture it is serving: the configured
 * stop surfaces resolve it through `detachSubagentsOnStop()`, the CLI's
 * bare-Escape stop always detaches, and shutdown always cascades. Omitting
 * the field means cascade, since a child left running has no owner.
 */
interface RunStop {
  /** Whether a live interrupt target took the stop, asked rather than read:
   *  the two child policies decide it at different moments. A cascading stop
   *  interrupts at admission and answers straight away; a detaching one
   *  interrupts only after {@link settlement} has committed the detach batch
   *  and severed the children locally, so it answers `false` until that has
   *  run. A caller that must decide synchronously is therefore a caller that
   *  cascades (headless shutdown, session close). */
  readonly accepted: () => boolean;
  /** Fails when a durable fact the stop owed storage was refused: the detach
   *  batch a `detachActiveChildren` stop commits is one such fact, and a
   *  caller that reported the stop done over it would be lying about it. */
  readonly settlement: Effect.Effect<void, Error>;
}

interface RunStopOptions {
  readonly detachActiveChildren?: boolean;
}

/**
 * A native child loop's lineage for the loop's whole life: from the
 * synchronous start of the loop, across every turn handle it tracks and
 * untracks, until its final result has reached the parent. The parent counts
 * it as an active child throughout, so its continuation stays recoverable
 * until the last delivery landed. Child-run loops use their run handle.
 */
interface ChildRunActivation {
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly interrupt: () => void;
  readonly detach: () => void;
  readonly isDetached: () => boolean;
}

/**
 * A run parked at WAITING: the fiber its generation stayed on, waiting inside
 * the scope that holds the run's teardown. Completing the latch ends the run
 * through the lifecycle's terminal path; interrupting the fiber where it
 * waits ends the park alone, which is what a resumed generation does.
 */
interface ParkedRun {
  readonly fiber: Fiber.Fiber<void>;
  readonly stopped: Deferred.Deferred<void>;
}

/**
 * Where a follow-up for a run goes: a live flow context, the run's
 * retained queue (a WAITING or resuming cursor, or a parent whose children
 * are still active), or nowhere in this process.
 */
export type ToolUseFollowUpTarget =
  | {
      readonly kind: 'active';
      readonly context: LiveToolUseFlowContext;
    }
  | { readonly kind: 'queue' }
  | {
      readonly kind: 'no_session';
      readonly runStatus: RunPhase | undefined;
    };

type ManualCompactionRequestResult =
  | {
      readonly kind: 'requested';
      readonly runId: RunId;
      readonly session: SessionHandle;
    }
  | {
      readonly kind: 'no_active_tool_use';
      readonly runId?: RunId;
    };

/**
 * The registry reads a run's phase from the session's fold (`RunView.status`,
 * one run model, 3.3) and keeps no phase of its own; the session routes each
 * phase-moving row it committed through `handleStatus` once the view has
 * folded it, so the registry's waiters and child rosters follow the one rail
 * every renderer reads and never read it a row behind.
 */
interface RunRegistryInit {
  readonly runView: (runId: RunId) => RunView | undefined;
  /** The session's awaited publisher (`SessionHandle.commit`) for the
   *  registry's own durable fact, a severed parent edge (`run.detach`). One
   *  batch carries every child of a detaching parent, so it is no single
   *  run's fact and no run's drain would ever hear it refused: the caller
   *  that asked for the sever is the one owner that can. */
  readonly commit: (
    events: readonly SessionEventDraft[],
  ) => Effect.Effect<void, Error>;
  readonly approvals: SessionApprovals;
  readonly finalizeRun: (
    input: FinalizeRunInput,
  ) => Effect.Effect<FinalizeRunResult, Error>;
  /**
   * Admit one run's claim (`SessionHandle.acquireClaims`) and hand back its
   * release. A run aggregate takes an append from its claim holder alone, so
   * a stop that reached no live handle takes the claim the same fenced way a
   * decision over a dead owner does (`SessionRequests.decide`) before it
   * writes the run's terminal row.
   */
  readonly acquireRunClaim: (
    runId: RunId,
  ) => Effect.Effect<Effect.Effect<void, Error>, Error>;
}

/**
 * Session-owned registry of active runs and their change listeners.
 *
 * One instance belongs to each session, built by the session layer in the
 * session's scope over that session's event hub, approvals, and lease-release
 * boundary, and provided as {@link Runs}.
 */
export class RunRegistry {
  private readonly handles = new Map<RunId, RunHandle>();
  private disposed = false;
  /** Set by {@link closeAdmissions}: the session is closing. */
  private closing = false;
  /** The stops begun for each run ({@link beginStop}), one token apiece:
   *  the run admits no new child until every one of them has settled
   *  ({@link throughStop}) or a new generation of it takes the lane
   *  ({@link launchRun}). Two overlapping stops of one parent each hold the
   *  gate they opened, so the first to settle cannot admit a child the
   *  second's snapshot has already left behind. */
  private readonly stopping = new Map<RunId, Set<symbol>>();
  /** The children a detach in flight has snapshotted, each held until that
   *  detach settles ({@link throughDetach}). Its batch lands on the child's
   *  own aggregate, which takes an append from its claim holder alone, so a
   *  child that ends in this window keeps its claim until the batch has
   *  committed instead of having it refused with nothing severed. */
  private readonly detaching = new Map<RunId, Deferred.Deferred<void>>();
  private readonly runView: (runId: RunId) => RunView | undefined;
  private readonly commit: (
    events: readonly SessionEventDraft[],
  ) => Effect.Effect<void, Error>;
  private readonly approvals: SessionApprovals;
  private readonly finalizeRun: RunRegistryInit['finalizeRun'];
  private readonly acquireRunClaim: RunRegistryInit['acquireRunClaim'];
  private readonly listeners = new Map<
    string,
    Set<(handle: RunHandle | undefined) => void>
  >();
  private readonly childActivations = new Map<RunId, ChildRunActivation>();
  /** The fiber of every run parked at WAITING in this session ({@link park}). */
  private readonly parked = new Map<RunId, ParkedRun>();
  /** The session's child-run concurrency budget, made on first use
   *  ({@link childRunBudget}). */
  private budget: Semaphore.Semaphore | undefined;
  private readonly lanes = new RunLanes();

  constructor(options: RunRegistryInit) {
    this.commit = options.commit;
    this.runView = options.runView;
    this.approvals = options.approvals;
    this.finalizeRun = options.finalizeRun;
    this.acquireRunClaim = options.acquireRunClaim;
  }

  /**
   * One phase-moving row this process committed (`run.activate`, the `waiting`
   * step and the step that leaves it, `run.end`), from the session's
   * fold-gated tail in commit order: notify the waiters on this run, which
   * read the new phase from the view here — why the caller delivers the row
   * only once the view has folded it.
   */
  handleStatus(runId: RunId): void {
    if (this.disposed) return;
    const handle = this.handles.get(runId);
    if (!handle) return;
    this.notifyWaiters(handle.runId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Error(
      'Cannot register run work after session disposal.',
    );
    this.lanes.disposeAll(disposal);
    // Parked fibers are interrupted where they wait: the session is gone, so
    // no terminal row of theirs is this process's to write.
    for (const parked of this.parked.values()) parked.fiber.interruptUnsafe();
    this.parked.clear();
    const runIds = [...this.handles.keys()];
    this.handles.clear();
    for (const runId of runIds) this.notifyWaiters(runId);
    this.childActivations.clear();
    this.stopping.clear();
    this.listeners.clear();
  }

  /**
   * Whether a generation of `runId` is live in this process — holding its
   * lane, still unwinding, or carrying a live tool-use flow: the states in
   * which a resume must be refused outright rather than queued on the run
   * lane, since it would otherwise start a fresh generation over a live one.
   * A run parked at WAITING is not one of them: the resume supersedes its
   * fiber ({@link park}), which is what leaves it resumable.
   *
   * Local ownership, never the durable phase: a crash leaves the phase RUNNING
   * by design, and an orphaned run in that phase is what a resume takes over.
   */
  isActiveOrResuming(runId: RunId): boolean {
    return (
      this.lanes.isHeld(runId) ||
      this.getToolUseFlowContext(runId) !== undefined
    );
  }

  /** Reserve an inactive run for deletion; never wait for a live owner. */
  withInactiveRunStep<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      this.assertActive();
      return this.lanes.launch(runId, operation, () =>
        this.hasRetainedOwner(runId),
      );
    });
  }

  /**
   * Hold an inactive run for the caller's scope, refusing a live owner:
   * {@link withInactiveRunStep}'s admission, for a caller whose decision has
   * to keep holding after the step that took it returned.
   */
  holdInactiveRun(runId: RunId): Effect.Effect<void, Error, Scope.Scope> {
    return Effect.suspend(() => {
      this.assertActive();
      return this.lanes.holdInactive(runId, () => this.hasRetainedOwner(runId));
    });
  }

  /** A handle or a child activation this session still retains for `runId`. */
  private hasRetainedOwner(runId: RunId): boolean {
    return this.handles.has(runId) || this.childActivations.has(runId);
  }

  /** Run a generation after earlier work and retain its lane through cleanup. */
  launchRun<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      this.assertActive();
      // A generation admitted through the lane is this run starting again:
      // whatever stop the run was marked for belongs to the generation it
      // ended, and the one taking the lane admits children of its own. The
      // lane is what makes this a separate admission rather than the same
      // stop's own bookkeeping ({@link beginStop}) — a turn handle the
      // stopping generation replaces takes no lane, so it no longer reopens
      // a window the stop is still closing.
      this.stopping.delete(runId);
      return this.lanes.launch(runId, operation);
    });
  }

  /**
   * The session's one child-run concurrency budget: the cap on concurrently
   * live native child model conversations (`childRunBudget.ts` holds the
   * design and the configured value). Made at `permits` on first call and
   * re-pinned on every later one, so a settings change takes effect at the
   * next child launch and sharing loops pick it up on their next turn.
   */
  childRunBudget(permits: number): Effect.Effect<Semaphore.Semaphore> {
    return Effect.suspend(() => {
      const existing = this.budget;
      if (existing) return existing.resize(permits).pipe(Effect.as(existing));
      const budget = Semaphore.makeUnsafe(permits);
      this.budget = budget;
      return Effect.succeed(budget);
    });
  }

  /**
   * Park `handle`'s run on its own stop latch: the generation that reached
   * WAITING stays here as a fiber holding the run's teardown, instead of
   * returning and leaving that teardown behind for someone else to invoke.
   * Completing the latch ({@link terminate}) runs `termination`, the run's own
   * terminal path; interrupting the fiber where it waits ({@link track},
   * {@link dispose}) ends the park and nothing else. The fiber leaves the map
   * when it ends, so a run parked here is one this process still holds.
   */
  park(
    handle: RunHandle,
    stopped: Deferred.Deferred<void>,
    termination: Effect.Effect<void>,
  ): Effect.Effect<void> {
    const runId = handle.runId;
    return Effect.forkDetach(
      Deferred.await(stopped).pipe(Effect.andThen(termination)),
    ).pipe(
      Effect.tap((fiber) =>
        Effect.sync(() => {
          const entry: ParkedRun = { fiber, stopped };
          this.parked.set(runId, entry);
          const forget = (): void => {
            if (this.parked.get(runId) === entry) this.parked.delete(runId);
          };
          fiber.addObserver(forget);
        }),
      ),
      Effect.asVoid,
    );
  }

  /** Whether a generation of `runId` is parked at WAITING here ({@link park}):
   *  the run is held, but by a fiber a resume supersedes rather than by a
   *  generation a resume would run beside. */
  isParked(runId: RunId): boolean {
    return this.parked.has(runId);
  }

  /** Register a run handle. */
  track(handle: RunHandle): void {
    this.assertActive();
    if (handle.parent !== null)
      this.assertAdmitsChild(handle.parent, handle.runId);
    const previous = this.handles.get(handle.runId);
    const activation = this.childActivations.get(handle.runId);
    // A handle replacing this run's registration takes the lineage that
    // registration holds now. `detach` is the only write to a parent edge and
    // no run grows one it did not start with, so a tracked handle (or a child
    // activation) without one has been severed by its parent's detaching stop
    // — possibly while this successor was being prepared, from a parent edge
    // the successor was built with. Carrying the sever in the same step that
    // swaps the handles is what stops a handle built before a `run.detach`
    // from restoring the edge that row removed.
    if (activation?.isDetached() || previous?.parent === null) handle.detach();
    // This registration is the run starting again, so the generation parked
    // at WAITING is over: its fiber is interrupted where it waits and its
    // termination never runs. A stop that already woke that fiber is past
    // interrupting, so it crosses the handoff with the registration instead.
    const parked = this.parked.get(handle.runId);
    if (parked) {
      this.parked.delete(handle.runId);
      parked.fiber.interruptUnsafe();
    }
    if (previous?.stopRequested === true) handle.interrupt();
    this.handles.set(handle.runId, handle);
    this.notifyWaiters(handle.runId);
  }

  /**
   * Refuse every run registered from here on: the session is closing
   * (`Sessions.close`). The runs already tracked keep their handles, waiters
   * and status until they settle, and a native child loop keeps its activation
   * until its final delivery, which is what the close waits for
   * ({@link getActiveIds}); only new admissions are turned away.
   */
  closeAdmissions(): void {
    this.closing = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Cannot register run work after session disposal.');
    }
    if (this.closing) {
      throw new Error('Cannot register run work while the session is closing.');
    }
  }

  /**
   * Refuse a child admitted under a parent whose stop has begun
   * ({@link beginStop}), the way {@link assertActive} refuses one admitted
   * under a closing session. A child this registry already holds is not an
   * admission: a native child's activation and every turn handle it tracks
   * re-enter here while the detach runs, and those are the children the stop
   * is severing, not new ones.
   */
  private assertAdmitsChild(parentRunId: RunId, childRunId: RunId): void {
    if (!this.stopping.has(parentRunId)) return;
    if (this.hasRetainedOwner(childRunId)) return;
    throw new Error(
      `Cannot launch child run ${childRunId} under run ${parentRunId} while that run is stopping.`,
    );
  }

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
   * settles, no new child is admitted under it ({@link assertAdmitsChild}).
   * A cascading stop takes the same mark for the same reason.
   *
   * The mark is the stop's, so {@link throughStop} owns its whole life: a
   * multi-turn parent tracking its next turn's handle mid-detach is not the
   * stop ending, and a run whose next generation takes the lane
   * ({@link launchRun}) has left the stop behind either way.
   */
  private beginStop(runId: RunId): symbol {
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
  private throughStop(
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

  /** The wait a child's lease release takes before it drops its claim
   *  (`SessionHandle.releaseRunLease`, the one release): nothing unless a
   *  detach of its parent is in flight over it, and that detach's settlement
   *  otherwise. */
  throughDetach(runId: RunId): Effect.Effect<void> {
    const detached = this.detaching.get(runId);
    return detached === undefined ? Effect.void : Deferred.await(detached);
  }

  /** Remove a run handle and notify waiters. */
  untrack(runId: RunId): void {
    const handle = this.handles.get(runId);
    if (!handle) {
      this.notifyWaiters(runId);
      return;
    }

    this.untrackHandle(handle);
  }

  /** Remove `handle` only if it is still the current registration. */
  untrackIfCurrent(handle: RunHandle): boolean {
    if (this.handles.get(handle.runId) !== handle) return false;
    this.untrackHandle(handle);
    return true;
  }

  private untrackHandle(handle: RunHandle): void {
    this.handles.delete(handle.runId);
    this.notifyWaiters(handle.runId);
  }

  getHandle(runId: RunId): RunHandle | undefined {
    return this.handles.get(runId);
  }

  getStatus(handle: RunHandle): RunStatusInfo & { status: RunPhase } {
    const run = this.runView(handle.runId);
    // A tracked run whose activation has not folded yet is running: the
    // handle exists because its process is live.
    const status: RunPhase =
      run === undefined || run.status === 'ready'
        ? RUN_PHASE.RUNNING
        : run.status;
    const runStartedAt = run?.runStartedAt ?? null;

    if (!isActivePhase(status) || runStartedAt === null) {
      return { status, elapsed: null };
    }

    return {
      status,
      elapsed: formatDuration(Date.now() - runStartedAt),
    };
  }

  getAgentHandles(): RunHandle[] {
    return [...this.handles.values()];
  }

  getToolUseFlowContext(runId: RunId): LiveToolUseFlowContext | undefined {
    return this.handles.get(runId)?.getToolUseFlow();
  }

  /**
   * Request manual compaction from the active tool-use flow, if one exists.
   * Hosts own the user-facing message, but the registry owns the live-flow
   * lookup so CLI and extension do not rederive the same runtime facts.
   */
  requestManualCompaction(
    runId: RunId | undefined,
  ): ManualCompactionRequestResult {
    if (!runId) return { kind: 'no_active_tool_use' };
    const context = this.getToolUseFlowContext(runId);
    if (!context) return { kind: 'no_active_tool_use', runId };

    context.requestImmediateCompaction();
    return {
      kind: 'requested',
      runId,
      session: context.ownerSession,
    };
  }

  /** Decide how a tool-use follow-up is admitted, from one registry-owned
   *  snapshot of run status, active flow context, and child runs. */
  getToolUseFollowUpTarget(runId: RunId): ToolUseFollowUpTarget {
    const run = this.runView(runId);
    const status: RunPhase | undefined =
      run === undefined || run.status === 'ready' ? undefined : run.status;

    if (status !== undefined && !isInFlightPhase(status)) {
      // Only a native child's explicit delivery reservation can retain a
      // terminal parent's continuation. A child-run handle is lifecycle
      // ownership, not authority to revive a parent that already finished.
      for (const activation of this.activeChildActivations(runId)) {
        return { kind: 'queue' };
      }
      return { kind: 'no_session', runStatus: status };
    }

    const context = this.getToolUseFlowContext(runId);
    if (context) return { kind: 'active', context };

    if (
      run?.substate === RUN_SUBSTATE.RESUMING ||
      status === RUN_PHASE.WAITING ||
      this.hasActiveChildren(runId)
    ) {
      return { kind: 'queue' };
    }
    return { kind: 'no_session', runStatus: status };
  }

  /**
   * Terminate a run via its handle, or, for a native child loop between turns
   * (an activation with no turn handle), interrupt the loop itself. A
   * cascading stop is admitted synchronously and a detaching one with its
   * settlement ({@link RunStop.accepted}); either way the caller executes the
   * returned settlement at its Effect boundary before releasing ownership.
   */
  kill(runId: RunId, options: RunStopOptions = {}): RunStop {
    const stopToken = this.beginStop(runId);
    const handle = this.handles.get(runId);
    if (!handle) {
      const activation = this.childActivations.get(runId);
      activation?.interrupt();
      this.notifyWaiters(runId);
      const reached = activation !== undefined;
      return {
        accepted: () => reached,
        settlement: this.throughStop(runId, stopToken, Effect.void),
      };
    }
    const visited = new Set<string>();
    const settlements: Effect.Effect<void, Error>[] = [];
    let reached = false;
    const stopRoot = (): Effect.Effect<void, Error> => {
      reached = this.terminate(
        handle,
        visited,
        options.detachActiveChildren !== true,
        settlements,
      );
      // Always notify waiters — even if terminate() returned false (e.g. PID
      // not yet assigned), callers blocking on this run should be unblocked.
      this.notifyWaiters(runId);
      return Effect.all(settlements, {
        concurrency: 'unbounded',
        discard: true,
      });
    };
    return {
      accepted: () => reached,
      settlement: this.throughStop(
        runId,
        stopToken,
        options.detachActiveChildren === true
          ? // The children leave the parent before the parent is interrupted:
            // the sever the commit applies is what stops a child completing in
            // this window from routing its terminal delivery to a run this
            // stop has just ended.
            this.detachActiveChildren(handle.runId).pipe(
              Effect.andThen(Effect.suspend(stopRoot)),
            )
          : stopRoot(),
      ),
    };
  }

  /**
   * Every run live in this session: the tracked handles and the native child
   * loops retained between turns, whose activation is the only record of them.
   * This is what a close stops and waits on, so a child with final delivery
   * still to do is never left running under a released session.
   */
  getActiveIds(): RunId[] {
    return [
      ...new Set([...this.handles.keys(), ...this.childActivations.keys()]),
    ];
  }

  /**
   * Kill only background OS processes (bash, codex) without touching agent run
   * status. Agent runs are left in RUNNING: whether one is resumable is
   * decided from its durable facts, never from a phase a later pass rewrites.
   * `interruptBackgroundProcess()` fires only for a handle whose interrupt
   * handler declares itself as owning a live background process, leaving every
   * other `RunHandle` untouched (#8155).
   */
  killBackgroundProcesses(): void {
    for (const handle of this.handles.values()) {
      handle.interruptBackgroundProcess();
    }
  }

  /**
   * Wait for any of the given runs to change — see {@link addListener} for the
   * full wake set — and succeed with the run id that changed first.
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
   * Resolve once every run this registry holds has left it: the drain a
   * session close and a project close both wait on, over {@link getActiveIds}.
   *
   * Interrupting the waiting fiber — which is what a close budget does —
   * detaches the registry listeners with it. The re-check arm is load-bearing:
   * `raceAllFirst` starts its arms in order, so the wait registers first and
   * the re-check then sees a last run that left between the read above and
   * those listeners, instead of waiting out the whole close budget for a
   * notification that can no longer come.
   */
  awaitDrained(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (;;) {
        const active = this.getActiveIds();
        if (active.length === 0) return;
        yield* Effect.raceAllFirst([
          this.waitForAnyChange(active).pipe(Effect.asVoid),
          Effect.suspend(() =>
            this.getActiveIds().length === 0 ? Effect.void : Effect.never,
          ),
        ]);
      }
    });
  }

  private *activeChildActivations(
    parentRunId: RunId,
  ): Generator<ChildRunActivation> {
    for (const activation of this.childActivations.values()) {
      if (activation.parentRunId === parentRunId && !activation.isDetached()) {
        yield activation;
      }
    }
  }

  /** Interrupt all active subagents of a parent run, including descendants. */
  private interruptActiveChildren(
    parentRunId: RunId,
    visited: Set<string>,
    cascadeChildren: boolean,
    settlements: Effect.Effect<void, Error>[],
  ): void {
    // A loop between turns has no handle to interrupt; a loop inside a turn
    // also gets its turn handle terminated below. The activation is keyed
    // apart from the handle so each is interrupted once per stop.
    for (const activation of this.activeChildActivations(parentRunId)) {
      const key = `activation:${activation.runId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      activation.interrupt();
    }
    for (const handle of this.handles.values()) {
      if (handle.isOwnedBy(parentRunId)) {
        this.terminate(handle, visited, cascadeChildren, settlements);
      }
    }
  }

  /**
   * Detach all active subagents from a parent, promoting them to top-level.
   * Subagents continue running independently and deliver results via the
   * follow-up queue. Called when stopping an orchestrator without killing
   * children.
   *
   * The durable batch comes first and the local sever follows it, on the
   * children that batch committed: a refused commit leaves both the durable
   * parent edges and the local relationships standing, so a retry still finds
   * the children to detach. It carries every severed child at once,
   * activations included, so a caller must not re-derive the set from the
   * tracked handles and publish `run.detach` for the difference; and a batch
   * spanning run ids belongs to no single run, so no run's drain would ever
   * hear it refused. A stop that reported done over a refused batch would
   * leave the children durably parented, and a later delete of the parent
   * would collect the children the user chose to keep running.
   *
   * The set taken here stays the parent's whole child roster while the batch
   * commits: the stop marked the parent before reading it ({@link beginStop}),
   * so no child is admitted under it in the window this covers.
   *
   * Each row lands on its own child's aggregate, which takes an append only
   * from its claim holder, and a child that ends while the batch waits would
   * release its claim and have the whole batch refused with nothing severed.
   * So every snapshotted child is claimed here, the way an ownerless stop
   * claims its target ({@link stopAgentRun}), and named in {@link detaching}
   * until the commit and the local sever are done: a live child's own claim is
   * one this acquire retains nothing of, so what holds it is that child's
   * lease release waiting here ({@link throughDetach}).
   */
  detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    const detachedChildRunIds = this.childRunIds(parentRunId);
    if (detachedChildRunIds.length === 0) return Effect.void;
    return Effect.suspend(() => {
      const detached = Deferred.makeUnsafe<void>();
      for (const childRunId of detachedChildRunIds)
        this.detaching.set(childRunId, detached);
      return Effect.scoped(
        Effect.forEach(
          detachedChildRunIds,
          (childRunId) =>
            Effect.acquireRelease(this.acquireRunClaim(childRunId), (release) =>
              release.pipe(Effect.orDie),
            ),
          { discard: true },
        ).pipe(
          Effect.andThen(
            this.commit(
              detachedChildRunIds.map((childRunId) => ({
                type: 'run.detach',
                aggregateId: qualifyAggregateId('run', childRunId),
              })),
            ),
          ),
          Effect.andThen(
            Effect.sync(() => {
              this.detachChildren(parentRunId, detachedChildRunIds);
            }),
          ),
        ),
      ).pipe(
        // Whatever the batch did, the children stop waiting here: a refused
        // commit leaves both edges standing and a retry snapshots them again,
        // and a child holding its claim for a detach that will never commit
        // would never end.
        Effect.ensuring(
          Effect.sync(() => {
            for (const childRunId of detachedChildRunIds)
              if (this.detaching.get(childRunId) === detached)
                this.detaching.delete(childRunId);
            Deferred.doneUnsafe(detached, Effect.void);
          }),
        ),
      );
    });
  }

  /** The children one parent's detach covers. A Set, not an array: a child
   *  detached mid-turn has both a per-turn handle and a ChildRunActivation
   *  under one runId, so both loops reach the same child and it must still be
   *  published (and severed) exactly once. */
  private childRunIds(parentRunId: RunId): readonly RunId[] {
    const childRunIds = new Set<RunId>();
    for (const activation of this.activeChildActivations(parentRunId))
      childRunIds.add(activation.runId);
    for (const handle of this.handles.values())
      if (handle.isOwnedBy(parentRunId)) childRunIds.add(handle.runId);
    return [...childRunIds];
  }

  /** Apply parent removal to local handles and approval ancestry without
   *  publishing, over the children a durable detach already covers: the batch
   *  {@link detachActiveChildren} committed, or a committed `run.removed`. */
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

  /**
   * Stop a visible agent run and apply the caller's declared child policy.
   * Hosts call this instead of reconstructing stop behavior from
   * child-interrupts, root interrupts, and run-status writes.
   *
   * Fails when the run's terminal row could not be written: the run is still
   * in flight, and a caller that reported the stop done would be lying.
   *
   * A stop of a run no handle here owns writes that row from outside the run,
   * so the run's claim fences the whole gesture, descendant sweep included:
   * taken first, a refusal leaves the descendants running instead of severing
   * them and then reporting the stop unavailable. A locally owned run is
   * already this process's to stop and takes the direct path.
   */
  stopAgentRun(
    runId: RunId,
    options: RunStopOptions = {},
  ): Effect.Effect<void, Error> {
    if (this.handles.has(runId)) return this.applyStop(runId, options);
    return Effect.acquireUseRelease(
      this.acquireRunClaim(runId),
      () => this.applyStop(runId, options),
      (release) => release.pipe(Effect.orDie),
    );
  }

  /**
   * Apply one stop: the descendant policy the caller declared, the root
   * handle's own termination, and — when no live handle took it — the terminal
   * row an ownerless stop must write itself. A detaching policy is the whole
   * first step: the children leave the parent, durably and then locally,
   * before anything interrupts it, because a child completing while that batch
   * commits would otherwise route its terminal result to the just-stopped
   * parent and the later sever cannot take that routing back.
   */
  private applyStop(
    runId: RunId,
    options: RunStopOptions,
  ): Effect.Effect<void, Error> {
    const stopToken = this.beginStop(runId);
    const detached =
      options.detachActiveChildren === true
        ? this.detachActiveChildren(runId)
        : Effect.void;
    return this.throughStop(
      runId,
      stopToken,
      detached.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const rootHandle = this.handles.get(runId);
            // Shared across the child sweep and the root cascade so each run in
            // the chain is interrupted exactly once.
            const visited = new Set<string>();
            const settlements: Effect.Effect<void, Error>[] = [];

            if (options.detachActiveChildren !== true) {
              this.interruptActiveChildren(runId, visited, true, settlements);
            }

            const stopped = rootHandle
              ? this.terminate(
                  rootHandle,
                  visited,
                  options.detachActiveChildren !== true,
                  settlements,
                )
              : false;
            // `terminate()` already finalizes a run it owned; an ownerless (or
            // already-untracked) run still needs the `run.end` row, which is the
            // run's terminal fact: without the finalize below the fold, history
            // and every other host would keep the stopped run in flight.
            const all: Effect.Effect<void, Error>[] = stopped
              ? settlements
              : [...settlements, this.finalizeOwnerlessStop(runId)];
            return Effect.all(all, { concurrency: 'unbounded', discard: true });
          }),
        ),
      ),
    );
  }

  /**
   * Register a change waiter for `runId` and return its disposer.
   *
   * The full wake set, which is what an `executions wait` observes:
   *
   * - a status transition on this run;
   * - {@link track}, including a *replacement* handle for the same id (a
   *   resumed generation taking over from its predecessor) — a `track` that
   *   skipped this would strand a waiter across a resume;
   * - {@link untrack}, including for an id that holds no handle;
   * - {@link kill}, unconditionally, even when no live interrupt target was
   *   reached;
   * - {@link dispose}, for every run still tracked at session teardown.
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

  /** Retain a native child loop's lineage until the returned disposer runs,
   *  which the loop does only after its final delivery to the parent. */
  reserveChildActivation(activation: ChildRunActivation): () => void {
    this.assertActive();
    if (this.childActivations.has(activation.runId)) {
      return () => {};
    }
    this.assertAdmitsChild(activation.parentRunId, activation.runId);
    this.childActivations.set(activation.runId, activation);
    return () => this.releaseChildActivation(activation.runId, activation);
  }

  hasActiveChildren(parentRunId: RunId): boolean {
    return this.childRunIds(parentRunId).length > 0;
  }

  private terminate(
    handle: RunHandle,
    visited: Set<string>,
    cascadeChildren: boolean,
    settlements: Effect.Effect<void, Error>[],
  ): boolean {
    if (visited.has(handle.runId)) return false;
    visited.add(handle.runId);
    if (cascadeChildren) {
      this.interruptActiveChildren(handle.runId, visited, true, settlements);
    }
    // A child run is its loop, not only the turn this handle runs:
    // stopping it ends the loop too, so the interrupted turn is not delivered
    // to the parent as a completed one.
    const activation = this.childActivations.get(handle.runId);
    let activationInterrupted = false;
    if (activation && !activation.isDetached()) {
      const key = `activation:${activation.runId}`;
      if (!visited.has(key)) {
        visited.add(key);
        activation.interrupt();
        activationInterrupted = true;
      }
    }
    const interrupted = handle.interrupt();
    // A run parked at WAITING is stopped by completing the latch its fiber
    // waits on: that fiber writes the run's terminal row through the same path
    // a running generation takes, and this stop settles when it does. Read
    // after `interrupt()`, whose handler may be a resume's launch stop rather
    // than this run's, so the parked run is ended here either way.
    const parked = this.parked.get(handle.runId);
    if (parked) {
      Deferred.doneUnsafe(parked.stopped, Effect.void);
      settlements.push(Fiber.await(parked.fiber).pipe(Effect.asVoid));
      return true;
    }
    // The loop's own interrupt already carried the stop into the turn: the
    // native-subagent strategy links the loop signal to this handle, so
    // aborting the loop spends the handle's interrupt target before we reach
    // it. The delivered stop is the admission, exactly as the handle-less
    // branch of `kill` reports an activation-only stop.
    if (interrupted || activationInterrupted) return true;
    return false;
  }

  /**
   * Write the terminal fact for a stop that reached no live handle, through
   * the run's one writer. `keepExistingOutcome` leaves a run that already
   * ended with its own verdict; the checkpoint is preserved, since a cancelled
   * run is exactly the one a user resumes. The row is an append on the run
   * aggregate, which takes one only from its claim holder: {@link stopAgentRun}
   * holds that claim around the whole ownerless stop. A refusal fails the stop
   * rather than being logged behind a caller that reported it done.
   */
  private finalizeOwnerlessStop(runId: RunId): Effect.Effect<void, Error> {
    return this.finalizeRun({
      runId,
      outcome: RUN_OUTCOME.CANCELLED,
      keepExistingOutcome: true,
    }).pipe(
      Effect.flatMap((finalization) =>
        finalization.ok
          ? Effect.void
          : Effect.fail(
              new Error(
                `Failed to finalize a stop with no live run handle for run ${runId}`,
                { cause: finalization.error },
              ),
            ),
      ),
    );
  }

  private notifyWaiters(runId: RunId): void {
    const listeners = this.listeners.get(runId);
    if (!listeners) return;

    const handle = this.handles.get(runId);
    // Iterate a snapshot so a listener disposing itself mid-fire is safe.
    for (const cb of [...listeners]) cb(handle);
  }

  private releaseChildActivation(
    runId: RunId,
    expected: ChildRunActivation,
  ): void {
    if (this.childActivations.get(runId) !== expected) return;
    this.childActivations.delete(runId);
    // The loop's last record is gone: a waiter on its settlement wakes.
    this.notifyWaiters(runId);
  }
}

/**
 * The session's runs (system design §2.1, §7.11): run admission and lanes,
 * the live handles, the parked fibers and the child roster of one session.
 * Built by the session layer in the session's scope and disposed when that
 * scope closes (`sessionLayer.ts`); the session record carries the same value
 * (`SessionHandle.runs`) for a host that holds the session. Effect code below
 * a launch takes it from context, provided where a session is resolved into
 * work: `executeAgent` (which `runAgent` delegates to), `resumeRun`,
 * `resumeClaimedRun`, `resumeToolUseFromResumeData`, `SessionRequests`, the
 * leftover-run sweep, and the VS Code language-model tools that call a tool
 * outside any run. `closeSession` reads it from the session entry.
 */
export class Runs extends Context.Service<Runs, RunRegistry>()(
  '@texra/session/Runs',
) {}
