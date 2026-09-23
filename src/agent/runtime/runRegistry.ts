/**
 * Handle-based run registry.
 *
 * The session-facing surface: admission, the launch-time bookkeeping a
 * `track` does, the projections hosts read, and the stop gestures they call.
 * What this process holds for a run — its handle, its child activation, the
 * its lifecycle lane and the
 * generations holding it — is one entry in `runRoster.ts`, the single
 * in-process liveness authority; what a stop does with those records lives in
 * `runStopping.ts`.
 */

import { Context, Effect, Semaphore, type Scope } from 'effect';

import {
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  type RunPhase,
} from '@shared/schemas';
import { isActivePhase, isInFlightPhase } from '@shared/runs/runStatus';
import { formatDuration } from '@utils/text/stringUtils';
import {
  type RunHandle,
  type RunStatusInfo,
  type LiveToolUseFlowContext,
} from './RunHandle';
import { RunRoster } from './runRoster';
import { RunStopper } from './runStopping';
import type {
  ChildRunActivation,
  ManualCompactionRequestResult,
  RunRegistryInit,
  RunStop,
  RunStopOptions,
  ToolUseFollowUpTarget,
} from './runRegistryTypes';

/**
 * Session-owned registry of active runs and their change listeners. One
 * instance belongs to each session, built by the session layer in that
 * session's scope and provided as {@link Runs}.
 */
export class RunRegistry {
  private disposed = false;
  /** Set by {@link closeAdmissions}: the session is closing. */
  private closing = false;
  private readonly roster: RunRoster;
  private readonly stopper: RunStopper;
  private readonly runView: RunRegistryInit['runView'];
  /** The session's child-run concurrency budget, made on first use
   *  ({@link childRunBudget}). */
  private budget: Semaphore.Semaphore | undefined;

  constructor(options: RunRegistryInit) {
    this.runView = options.runView;
    this.roster = new RunRoster(options.approvals);
    this.stopper = new RunStopper(
      this.roster,
      options.commit,
      options.finalizeRun,
      options.acquireRunClaim,
      options.runView,
    );
  }

  /**
   * One phase-moving row this process committed (`run.activate`, the `waiting`
   * step and the step that leaves it, `run.end`), from the session's
   * fold-gated tail in commit order: notify the waiters on this run, which
   * read the new phase from the view here — why the caller delivers the row
   * only once the view has folded it.
   *
   * A `run.end` folded to `cancelled` also closes the admission window its
   * stop left, so this interrupts the children admitted in it: the stop's
   * in-flight token lifts when its settlement does, before this fold
   * ({@link RunStopper.sweepChildrenOfFoldedStop}).
   */
  handleStatus(runId: RunId): void {
    if (this.disposed) return;
    this.stopper.sweepChildrenOfFoldedStop(runId);
    if (this.roster.handle(runId)) this.roster.notifyWaiters(runId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.roster.clear(
      new Error('Cannot register run work after session disposal.'),
    );
  }

  /**
   * Whether a generation of `runId` is live in this process — the roster's
   * one admission answer ({@link RunRoster.isLive}), which {@link launchRun}
   * also refuses on, inside its lane claim. Read here only by a caller that
   * must decide before it tracks a handle of its own, since tracking one
   * would replace the live generation's stop target.
   */
  isLive(runId: RunId): boolean {
    return this.roster.isLive(runId);
  }

  /** Reserve an inactive run for deletion; never wait for a live owner. */
  withInactiveRunStep<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      this.assertActive();
      return this.roster.launch(runId, operation, true);
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
      return this.roster.holdInactive(runId);
    });
  }

  /**
   * Run a generation after earlier work, holding its lane through cleanup, and
   * refuse with `RunLive` when a generation of the run is already live here
   * ({@link RunRoster.isLive}). The refusal is taken in the same synchronous
   * step as the lane claim, so it is the whole duplicate-launch answer: a
   * resume that would otherwise start a second generation over a live one is
   * refused here rather than by a caller's earlier read of the same fact. The
   * claim that survives it lifts the run's stop marks ({@link
   * RunRoster.launch}); a refused launch leaves the stop's gate intact.
   */
  launchRun<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      this.assertActive();
      return this.roster.launch(runId, operation);
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

  /** Register a run handle. */
  track(handle: RunHandle): void {
    this.assertActive();
    if (handle.parent !== null)
      this.assertAdmitsChild(handle.parent, handle.runId);
    const previous = this.roster.handle(handle.runId);
    if (previous?.stopRequested === true) handle.interrupt();
    this.roster.setHandle(handle);
    this.roster.notifyWaiters(handle.runId);
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
   * Refuse a child admitted under a parent whose stop has begun, the way
   * {@link assertActive} refuses one admitted under a closing session, and one
   * admitted under a parent whose stop has already folded
   * ({@link RunStopper.assertStopNotFolded}). Who is admissible during a stop
   * is the roster's ({@link RunRoster.admitsChild}): a child this registry
   * already holds is not an admission — a native child's activation and every
   * live handle it tracks re-enter here while the detach runs, and those are
   * the children the stop is severing, not new ones — so it takes no
   * folded-stop refusal either.
   */
  private assertAdmitsChild(parentRunId: RunId, childRunId: RunId): void {
    if (!this.roster.admitsChild(parentRunId, childRunId)) {
      throw new Error(
        `Cannot launch child run ${childRunId} under run ${parentRunId} while that run is stopping.`,
      );
    }
    if (this.roster.isStopping(parentRunId)) return;
    this.stopper.assertStopNotFolded(parentRunId, childRunId);
  }

  /** The wait a child's lease release takes before it drops its claim
   *  (`SessionHandle.releaseRunLease`, the one release): nothing unless a
   *  detach of its parent is in flight over it, and that detach's settlement
   *  otherwise. */
  throughDetach(runId: RunId): Effect.Effect<void> {
    return this.stopper.throughDetach(runId);
  }

  /** Remove a run handle and notify waiters. */
  untrack(runId: RunId): void {
    this.roster.deleteHandle(runId);
  }

  /** Remove `handle` only if it is still the current registration. */
  untrackIfCurrent(handle: RunHandle): boolean {
    return this.roster.deleteHandleIfCurrent(handle);
  }

  getHandle(runId: RunId): RunHandle | undefined {
    return this.roster.handle(runId);
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
    return this.roster.allHandles();
  }

  getToolUseFlowContext(runId: RunId): LiveToolUseFlowContext | undefined {
    return this.roster.handle(runId)?.getToolUseFlow();
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
      for (const activation of this.roster.activeChildActivations(runId)) {
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

  /** Terminate a run via its handle, or, for a native child loop between
   *  turns, interrupt the loop itself: `RunStopper.kill` has the contract the
   *  caller owes the returned {@link RunStop}. */
  kill(runId: RunId, options: RunStopOptions = {}): RunStop {
    return this.stopper.kill(runId, options);
  }

  /** Stop every top-level run, cascading into its children: the sweep a
   *  session close and a project close both run. A child with a handle is
   *  stopped by its parent's cascade; a native child between turns has no
   *  handle, and its kill interrupts the loop the registry retains for it.
   *  The kills are issued now; the answer joins their settlements, and
   *  fails as the first refused one does, for the caller to map into its
   *  own error channel. */
  stopAll(): Effect.Effect<void, Error> {
    const settlements = this.getActiveIds().flatMap((runId) =>
      this.getHandle(runId)?.isChild
        ? []
        : [this.kill(runId, { detachActiveChildren: false }).settlement],
    );
    return Effect.all(settlements, { concurrency: 'unbounded', discard: true });
  }

  /** Stop a visible agent run and apply the caller's declared child policy:
   *  the one gesture hosts call, whose choreography is `RunStopper`'s. */
  stopAgentRun(
    runId: RunId,
    options: RunStopOptions = {},
  ): Effect.Effect<void, Error> {
    return this.stopper.stopAgentRun(runId, options);
  }

  /** Detach all active subagents from a parent, promoting them to top-level:
   *  the durable `run.detach` batch and the local sever that follows it. */
  detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    return this.stopper.detachActiveChildren(parentRunId);
  }

  /** Apply parent removal to local handles and approval ancestry without
   *  publishing, over children a durable detach already covers: the batch
   *  {@link detachActiveChildren} committed, or a committed `run.removed`. */
  detachChildren(parentRunId: RunId, childRunIds?: readonly RunId[]): void {
    this.roster.detachChildren(parentRunId, childRunIds);
  }

  /**
   * Every run with an interrupt target: the tracked handles and native child
   * activations still preparing or delivering outside their engine handle.
   * This is what a close stops; {@link awaitDrained} also waits for ownership
   * retained beyond handle removal, through the run's final resource release.
   */
  getActiveIds(): RunId[] {
    return this.roster.activeIds();
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
    for (const handle of this.roster.allHandles()) {
      handle.interruptBackgroundProcess();
    }
  }

  /** Wait for any of the given runs to change — `RunRoster.waitForAnyChange`
   *  holds the wake set — and succeed with the run id that changed first. */
  waitForAnyChange(runIds: readonly RunId[]): Effect.Effect<RunId> {
    return this.roster.waitForAnyChange(runIds);
  }

  /** Resolve once every run this registry holds has left it: the drain a
   *  session close and a project close both wait on. */
  awaitDrained(): Effect.Effect<void> {
    return this.roster.awaitDrained();
  }

  /** Retain a native child loop's lineage until the returned disposer runs,
   *  which the loop does only after its final delivery to the parent. */
  reserveChildActivation(activation: ChildRunActivation): () => void {
    this.assertActive();
    if (this.roster.activation(activation.runId)) {
      return () => {};
    }
    if (activation.parent.current !== null)
      this.assertAdmitsChild(activation.parent.current, activation.runId);
    this.roster.addActivation(activation);
    return () => this.roster.removeActivation(activation.runId, activation);
  }

  hasActiveChildren(parentRunId: RunId): boolean {
    return this.roster.hasActiveChildren(parentRunId);
  }
}

/**
 * The session's runs (system design §2.1, §7.11): run admission and lanes,
 * the live handles, the child roster of one session.
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
