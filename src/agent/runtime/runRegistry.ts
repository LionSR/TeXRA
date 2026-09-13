/**
 * Handle-based run registry.
 *
 * Manages agent run handles and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import { Effect, type Scope } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type ActiveChildInfo,
  type RunId,
  type SessionEventDraft,
  type RunPhase,
} from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';
import { formatDuration } from '@utils/core';
import {
  type RunHandle,
  type RunStatusInfo,
  type LiveToolUseFlowContext,
} from './RunHandle';
import { RunLanes } from './runLanes';
import {
  WaitingTermination,
  type WaitingTerminationContext,
} from './waitingTermination';

/**
 * Child policy shared by `kill()` and `stopAgentRun()`. The caller owns the
 * decision because only it knows which gesture it is serving: the configured
 * stop surfaces resolve it through `detachSubagentsOnStop()`, the CLI's
 * focus-scoped bare-Escape stop always detaches, and process shutdown always
 * cascades. Omitting the field means cascade — the conservative reading, since
 * a child left running has no owner to report to.
 */
export interface RunStop {
  /** Whether a live interrupt target took the stop, asked rather than read:
   *  the two child policies decide it at different moments. A cascading stop
   *  interrupts at admission and answers straight away. A detaching stop
   *  interrupts only after {@link settlement} has committed the detach batch
   *  and severed the children locally — a child completing between the
   *  interrupt and that sever would still resolve the just-stopped parent as
   *  its delivery target — so it answers `false` until the settlement has run.
   *  A caller that must decide synchronously is therefore a caller that
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
 * untracks, until its final result has been delivered to the parent. The
 * parent counts it as an active child throughout, so the parent's continuation
 * stays recoverable until the last delivery has landed. Child-run loops use
 * their persistent run handle for lineage instead.
 */
export interface ChildRunActivation {
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly interrupt: () => void;
  readonly detach: () => void;
  readonly isDetached: () => boolean;
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
  /**
   * The session's one exit choreography (`SessionHandle.releaseRunLease`),
   * required so no construction path can silently release a lease without
   * settling the session's queued publications first.
   */
  readonly releaseRootRunLease: WaitingTerminationContext['releaseRootRunLease'];
  readonly finalizeRun: WaitingTerminationContext['finalizeRun'];
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
 * One instance belongs to each {@link SessionHandle}, which binds it to that
 * session's event hub, approvals, and lease-release boundary.
 */
export class RunRegistry {
  private readonly handles = new Map<RunId, RunHandle>();
  private disposed = false;
  /** Set by {@link closeAdmissions}: the session is closing. */
  private closing = false;
  /** The runs whose stop has begun ({@link beginStop}): each admits no new
   *  child until that stop settles ({@link throughStop}) or a new generation
   *  of it takes the lane ({@link launchRun}). */
  private readonly stopping = new Set<RunId>();
  private readonly runView: (runId: RunId) => RunView | undefined;
  private readonly commit: (
    events: readonly SessionEventDraft[],
  ) => Effect.Effect<void, Error>;
  private readonly childActivityListeners = new Set<
    (parentRunId: RunId, items: readonly ActiveChildInfo[]) => void
  >();
  private readonly approvals: SessionApprovals;
  private readonly releaseRootRunLease: WaitingTerminationContext['releaseRootRunLease'];
  private readonly finalizeRun: WaitingTerminationContext['finalizeRun'];
  private readonly acquireRunClaim: RunRegistryInit['acquireRunClaim'];
  private readonly listeners = new Map<
    string,
    Set<(handle: RunHandle | undefined) => void>
  >();
  private readonly childActivations = new Map<RunId, ChildRunActivation>();
  private readonly lanes = new RunLanes();
  private readonly waitingTermination: WaitingTermination;

  constructor(options: RunRegistryInit) {
    this.commit = options.commit;
    this.runView = options.runView;
    this.approvals = options.approvals;
    this.releaseRootRunLease = options.releaseRootRunLease;
    this.finalizeRun = options.finalizeRun;
    this.acquireRunClaim = options.acquireRunClaim;
    this.waitingTermination = new WaitingTermination({
      releaseRootRunLease: this.releaseRootRunLease,
      finalizeRun: this.finalizeRun,
      lanes: this.lanes,
      getHandle: (runId) => this.handles.get(runId),
      untrackIfCurrent: (handle) => this.untrackIfCurrent(handle),
      untrackHandle: (handle) => this.untrackHandle(handle),
    });
  }

  /**
   * The live child roster of a parent run, as this registry holds it:
   * live-only presentation state (never a plane row, contract C3), told to
   * the renderers that still draw a roster until the fold's `childIds` and
   * `rollup` replace it (PRD 5.1). Called on every roster change: a child
   * tracked, untracked, detached, or moved by a phase-moving row.
   */
  onChildActivity(
    listener: (parentRunId: RunId, items: readonly ActiveChildInfo[]) => void,
  ): () => void {
    this.childActivityListeners.add(listener);
    return () => {
      this.childActivityListeners.delete(listener);
    };
  }

  /**
   * One phase-moving row this process committed (`run.activate`, the
   * `waiting` step and the step that leaves it, `run.end`), from the
   * session's fold-gated tail in commit order: notify waiters and refresh the
   * child roster when a run's status changes (e.g. RUNNING to WAITING). Both
   * read the new phase from the view here, which is why the caller delivers
   * the row only once the view has folded it.
   */
  handleStatus(runId: RunId): void {
    if (this.disposed) return;
    const handle = this.handles.get(runId);
    if (!handle) return;
    this.notifyWaiters(handle.runId);
    if (handle.parent !== null) this.emitChildActivity(handle.parent);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.childActivityListeners.clear();
    const disposal = new Error(
      'Cannot register run work after session disposal.',
    );
    this.lanes.disposeAll(disposal);
    const runIds = [...this.handles.keys()];
    this.handles.clear();
    for (const runId of runIds) this.notifyWaiters(runId);
    this.childActivations.clear();
    this.stopping.clear();
    this.listeners.clear();
  }

  /**
   * Whether a generation of `runId` is live in this process — holding its
   * lane, still unwinding, or parked with a live tool-use flow: the states in
   * which a resume must be refused outright rather than queued on the run
   * lane, since it would otherwise start a fresh generation over a live one.
   *
   * Local ownership, never the durable phase: a crash leaves the phase RUNNING
   * by design (owner loss is the fold's interrupted reading, 5.2), and an
   * orphaned run in that phase is exactly what a resume exists to take over.
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
      return this.lanes.withInactiveStep(
        runId,
        () => this.hasRetainedOwner(runId),
        operation,
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

  /** Register a run handle. */
  track(handle: RunHandle): void {
    this.assertActive();
    if (handle.parent !== null)
      this.assertAdmitsChild(handle.parent, handle.runId);
    const previous = this.handles.get(handle.runId);
    const activation = this.childActivations.get(handle.runId);
    if (activation?.isDetached()) handle.detach();
    if (previous && previous.suspendedTerminationStarted) {
      // A resumed lifecycle can replace its suspended predecessor while the
      // predecessor's asynchronous teardown is still in progress. The
      // stop already claimed that run, so carry it across the ownership
      // handoff instead of allowing the successor to revive the run.
      handle.interrupt();
    }
    this.handles.set(handle.runId, handle);
    // The parent edge is already durable on the child's `run.start`; the
    // roster is the only thing a tracked child moves here.
    if (handle.parent !== null) this.emitChildActivity(handle.parent);
    this.notifyWaiters(handle.runId);
  }

  /**
   * Refuse every run registered from here on: the session is closing
   * (`Sessions.close`). The runs already tracked keep their handles,
   * waiters, and status until they settle, and a native child loop keeps
   * its activation until its final delivery, which is what the close waits
   * for ({@link getActiveIds}); only new admissions are turned away.
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
   * under a closing session.
   *
   * A child this registry already holds is not an admission: a native child's
   * activation and every turn handle it tracks re-enter here while the detach
   * runs, and those are the children the stop is severing, not new ones.
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
   * A cascading stop takes the same mark for the same reason — it interrupts
   * the children it can see at admission, and one admitted after that would
   * outlive the parent that owns it.
   *
   * The mark is the stop's, so {@link throughStop} owns its whole life: a
   * multi-turn parent tracking its next turn's handle mid-detach is not the
   * stop ending, and a run whose next generation takes the lane
   * ({@link launchRun}) has left the stop behind whether or not that stop
   * ever settled.
   */
  private beginStop(runId: RunId): void {
    this.stopping.add(runId);
  }

  /** End the stop's admission gate when its settlement does, succeeded or
   *  failed: a refused `run.detach` commit never reaches the interrupt, so
   *  the parent generation it marked is still running and still owns the
   *  children it launches next. */
  private throughStop(
    runId: RunId,
    settlement: Effect.Effect<void, Error>,
  ): Effect.Effect<void, Error> {
    return settlement.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.stopping.delete(runId);
        }),
      ),
    );
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
    if (handle.parent !== null) this.emitChildActivity(handle.parent);
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
   *
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

  /**
   * Decide how a tool-use follow-up should be admitted from one registry-owned
   * snapshot of run status, active flow context, and child runs.
   */
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

    const hasActiveChildren = this.hasActiveChildren(runId);
    const context = this.getToolUseFlowContext(runId);
    if (context) return { kind: 'active', context };

    if (
      run?.substate === RUN_SUBSTATE.RESUMING ||
      status === RUN_PHASE.WAITING ||
      hasActiveChildren
    ) {
      return { kind: 'queue' };
    }
    return { kind: 'no_session', runStatus: status };
  }

  /**
   * Terminate a run via its handle, or, for a native child loop
   * between turns (an activation with no turn handle), interrupt the loop
   * itself. A cascading stop is admitted synchronously and a detaching one
   * with its settlement, which is the order the stop itself requires
   * ({@link RunStop.accepted}); either way the caller executes the returned
   * settlement at its Effect boundary before releasing ownership.
   */
  kill(runId: RunId, options: RunStopOptions = {}): RunStop {
    this.beginStop(runId);
    const handle = this.handles.get(runId);
    if (!handle) {
      const activation = this.childActivations.get(runId);
      activation?.interrupt();
      this.notifyWaiters(runId);
      const reached = activation !== undefined;
      return {
        accepted: () => reached,
        settlement: this.throughStop(runId, Effect.void),
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
   * Every run live in this session: the tracked handles and the
   * native child loops retained between turns, whose activation is the
   * only record of them. This is what a close stops and waits on, so a
   * child with final delivery still to do is never left running under a
   * released session.
   */
  getActiveIds(): RunId[] {
    return [
      ...new Set([...this.handles.keys(), ...this.childActivations.keys()]),
    ];
  }

  /**
   * Kill only background OS processes (bash, codex) without touching agent
   * run status. Agent runs are left in RUNNING: whether one is
   * resumable afterwards is decided from its durable facts (a `flow.snapshot`
   * on the run aggregate, and no live run claim), never from a phase some
   * later pass rewrites.
   *
   * Killing a background run's underlying OS process requires
   * `interruptBackgroundProcess()`, which only fires for a handle whose
   * attached interrupt handler declares itself as owning a live background
   * process, leaving every other `RunHandle` (root/native-subagent
   * runs, loop-level interrupts) untouched (#8155).
   */
  killBackgroundProcesses(): void {
    for (const handle of this.handles.values()) {
      handle.interruptBackgroundProcess();
    }
  }

  /**
   * Wait for any of the given runs to change — see {@link addListener}
   * for the full wake set — and succeed with the run id that changed
   * first.
   *
   * A caller that wants a bounded wait races or times out this effect instead
   * of passing a deadline in: interrupting the waiting fiber is what detaches
   * the listeners, so an abandoned wait leaves nothing registered and no
   * caller has to read a sentinel to learn that its deadline, rather than an
   * run, ended the wait.
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
   * children that batch committed: a refused commit therefore leaves both the
   * durable parent edges and the local relationships standing, so a retry
   * still finds the children to detach. It carries every severed child at
   * once — activations included, which is why a caller must not re-derive the
   * set from `getActiveChildren` (handles only) and publish `run.detach` for
   * the difference: a native child between turns would be published twice —
   * and a batch spanning run ids belongs to no single run, so no run's own
   * drain would ever hear it refused. A stop that reported done over a
   * refused batch would leave the children durably parented, and a later
   * delete of the parent would collect the children the user chose to keep
   * running.
   *
   * The set taken here stays the parent's whole child roster while the batch
   * commits: the stop marked the parent before reading it ({@link beginStop}),
   * so no child is admitted under it in the window this covers.
   *
   * Each row lands on its own child's aggregate, which takes an append only
   * from its claim holder, and freezing admission does not stop a child from
   * finishing: one that ends while this batch waits releases its claim, and
   * the batch is then refused as a whole with nothing severed. So every
   * snapshotted child is held under the same fenced claim an ownerless stop
   * takes ({@link stopAgentRun}) until the commit and the local sever are
   * done — a child this process still owns re-claims nothing and releases
   * nothing, and one that just ended leaves a claim reclaimable under this
   * owner.
   */
  detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    const detachedChildRunIds = this.childRunIds(parentRunId);
    if (detachedChildRunIds.length === 0) return Effect.void;
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
    );
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
    this.emitChildActivity(parentRunId);
  }

  /**
   * Stop a visible agent run and apply the caller's declared child policy.
   *
   * Hosts should call this instead of reconstructing stop behavior from
   * child-interrupts, root interrupts, and run-status writes.
   *
   * Fails when the run's terminal row could not be written: the run is still
   * in flight, and a caller that reported the stop done would be lying about
   * it.
   *
   * A stop of a run no handle here owns writes that row from outside the
   * run, so the run's claim fences the whole gesture — the descendant sweep
   * included. Taken first, a refusal leaves the descendants running instead
   * of detaching or killing them and then reporting the stop unavailable. A
   * locally owned run is already this process's to stop and takes the direct
   * path.
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
   * handle's own termination, and — when no live handle took it — the
   * terminal row an ownerless stop must write itself.
   *
   * A detaching policy is the whole first step: the children leave the parent,
   * durably and then locally, before anything interrupts it. A child that
   * completes while that batch is still committing would otherwise resolve
   * the just-stopped parent as its delivery target and enqueue its terminal
   * result there, and the sever that arrives afterwards cannot take that
   * routing back.
   */
  private applyStop(
    runId: RunId,
    options: RunStopOptions,
  ): Effect.Effect<void, Error> {
    this.beginStop(runId);
    const detached =
      options.detachActiveChildren === true
        ? this.detachActiveChildren(runId)
        : Effect.void;
    return this.throughStop(
      runId,
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
   * inside the callback, so nothing observes a second wake through the same
   * callback.
   *
   * The callback receives the current handle, or `undefined` once the
   * run has been untracked (terminal event) or the session disposed.
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

  /**
   * Retain a native child loop's lineage until the returned disposer runs,
   * which the loop does only after its final delivery to the parent.
   */
  reserveChildActivation(activation: ChildRunActivation): () => void {
    this.assertActive();
    if (this.childActivations.has(activation.runId)) {
      return () => {};
    }
    this.assertAdmitsChild(activation.parentRunId, activation.runId);
    this.childActivations.set(activation.runId, activation);
    return () => this.releaseChildActivation(activation.runId, activation);
  }

  private emitChildActivity(parentRunId: RunId): void {
    const items = this.getActiveChildren(parentRunId);
    for (const listener of [...this.childActivityListeners]) {
      listener(parentRunId, items);
    }
  }

  /** Get active subagent children for a parent run. */
  getActiveChildren(parentRunId: RunId): ActiveChildInfo[] {
    const result: ActiveChildInfo[] = [];
    for (const handle of this.handles.values()) {
      if (!handle.isOwnedBy(parentRunId)) continue;
      const { status } = this.getStatus(handle);
      result.push({
        identity: handle.identity,
        agentName: handle.agentName,
        status,
        startedAt: handle.startedAt,
        childRunId: handle.runId,
        ...(handle.workflowPhase
          ? { workflowPhase: handle.workflowPhase }
          : {}),
      });
    }
    return result;
  }

  hasActiveChildren(parentRunId: RunId): boolean {
    for (const activation of this.activeChildActivations(parentRunId)) {
      return true;
    }
    for (const handle of this.handles.values()) {
      if (handle.isOwnedBy(parentRunId)) return true;
    }
    return false;
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
    if (handle.interrupt()) return true;
    // The loop's own interrupt already carried the stop into the turn: the
    // native-subagent strategy links the loop signal to this handle, so
    // aborting the loop spends the handle's interrupt target before we reach
    // it. The delivered stop is the admission, exactly as the handle-less
    // branch of `kill` reports an activation-only stop.
    if (activationInterrupted) return true;
    // No live interrupt context: a native subagent suspended at WAITING has
    // already had its tool-use session disposed and interrupt handler detached
    // (the tool-use loop's scope), while the handle stays tracked for resume
    // (runFlowWithLifecycle). Run the teardown it parked with instead of
    // silently no-oping the kill.
    const settlement = this.waitingTermination.terminateWaitingHandle(handle);
    if (!settlement) return false;
    settlements.push(settlement);
    return true;
  }

  /**
   * Write the terminal fact for a stop that reached no live handle, through
   * the run's one writer. `keepExistingOutcome` leaves a run that already
   * ended with its own verdict, which is what the status machine's refusal to
   * leave a terminal phase used to express. The checkpoint is preserved: a
   * cancelled run is exactly the one a user resumes.
   *
   * The row is an append on the run aggregate, which takes one only from its
   * claim holder: {@link stopAgentRun} holds that claim around the whole
   * ownerless stop, and a run this process still tracks is its own writer
   * already. A refusal — a live foreign owner, a rolled-back transaction —
   * fails the stop rather than being logged behind a caller that already
   * reported it done.
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
