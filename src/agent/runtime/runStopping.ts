/**
 * What a stop does.
 *
 * One stopper per session turns a stop gesture into the work it owes: the
 * descendant policy the caller declared, the root handle's own termination,
 * the durable `run.detach` batch a detaching stop commits, the terminal
 * row a stop that reached no live handle has to write itself, and the
 * children the stop's own fold catches behind it. Who is here to
 * be stopped is the roster's (`runRoster.ts`); the registry
 * (`runRegistry.ts`) is what hosts call.
 */

import { Deferred, Effect, Fiber } from 'effect';

import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import type { RunHandle } from './RunHandle';
import type {
  RunRegistryInit,
  RunStop,
  RunStopOptions,
} from './runRegistryTypes';
import type { RunRoster } from './runRoster';

export class RunStopper {
  /** The children a detach in flight has snapshotted, each held until that
   *  detach settles ({@link throughDetach}). Its batch lands on the child's
   *  own aggregate, which takes an append from its claim holder alone, so a
   *  child that ends in this window keeps its claim until the batch has
   *  committed instead of having it refused with nothing severed. */
  private readonly detaching = new Map<RunId, Deferred.Deferred<void>>();

  constructor(
    private readonly roster: RunRoster,
    private readonly commit: RunRegistryInit['commit'],
    private readonly finalizeRun: RunRegistryInit['finalizeRun'],
    private readonly acquireRunClaim: RunRegistryInit['acquireRunClaim'],
    private readonly runView: RunRegistryInit['runView'],
  ) {}

  /**
   * Terminate a run's live handle and its child delivery activation. A
   * cascading stop is admitted synchronously and a detaching one with its
   * settlement ({@link RunStop.accepted}); either way the caller executes the
   * returned settlement at its Effect boundary before releasing ownership.
   */
  kill(runId: RunId, options: RunStopOptions = {}): RunStop {
    const stopToken = this.roster.beginStop(runId);
    const handle = this.roster.handle(runId);
    if (!handle) {
      const activation = this.roster.activation(runId);
      activation?.interrupt();
      this.roster.notifyWaiters(runId);
      const reached = activation !== undefined;
      return {
        accepted: () => reached,
        settlement: this.roster.throughStop(runId, stopToken, Effect.void),
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
      this.roster.notifyWaiters(runId);
      return Effect.all(settlements, {
        concurrency: 'unbounded',
        discard: true,
      });
    };
    return {
      accepted: () => reached,
      settlement: this.roster.throughStop(
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
   * Stop a visible agent run and apply the caller's declared child policy.
   * Hosts call this instead of reconstructing stop behavior from
   * child-interrupts, root interrupts, and run-status writes.
   *
   * Fails when the run's terminal row could not be written: the run is still
   * in flight, and a caller that reported the stop done would be lying.
   *
   * A stop of a run no handle or child driver owns writes from outside the run,
   * so the run's claim fences the whole gesture, descendant sweep included:
   * taken first, a refusal leaves the descendants running instead of severing
   * them and then reporting the stop unavailable. A locally owned run is
   * already this process's to stop and takes the direct path.
   */
  stopAgentRun(
    runId: RunId,
    options: RunStopOptions = {},
  ): Effect.Effect<void, Error> {
    if (this.roster.handle(runId) || this.roster.activation(runId))
      return this.applyStop(runId, options);
    return Effect.acquireUseRelease(
      this.acquireRunClaim(runId),
      () => this.applyStop(runId, options),
      (release) => release.pipe(Effect.orDie),
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
   * commits: the stop marked the parent before reading it, so no child is
   * admitted under it in the window this covers.
   *
   * Each row lands on its own child's aggregate, which takes an append only
   * from its claim holder, and a child that ends while the batch waits would
   * release its claim and have the whole batch refused with nothing severed.
   * So every snapshotted child is claimed here, the way an ownerless stop
   * claims its target ({@link stopAgentRun}), and named in {@link detaching}
   * until the commit and the local sever are done: a live child's own
   * claim is one this acquire retains nothing of, so what holds it is that
   * child's lease release waiting there ({@link throughDetach}).
   */
  detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    const detachedChildRunIds = this.roster.childRunIds(parentRunId);
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
              this.roster.detachChildren(parentRunId, detachedChildRunIds);
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

  /**
   * Apply one stop: the descendant policy the caller declared, the root
   * handle or child driver's termination, and — when neither took it — the
   * terminal row an ownerless stop must write itself. A detaching policy is
   * the whole first step: the children leave the parent, durably and then
   * locally, before anything interrupts it, because a child completing while
   * that batch commits would otherwise route its terminal result to the
   * just-stopped parent, and the later sever cannot take that routing back.
   */
  private applyStop(
    runId: RunId,
    options: RunStopOptions,
  ): Effect.Effect<void, Error> {
    const stopToken = this.roster.beginStop(runId);
    const detached =
      options.detachActiveChildren === true
        ? this.detachActiveChildren(runId)
        : Effect.void;
    return this.roster.throughStop(
      runId,
      stopToken,
      detached.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const rootHandle = this.roster.handle(runId);
            // Shared across the child sweep and the root cascade so each run in
            // the chain is interrupted exactly once.
            const visited = new Set<string>();
            const settlements: Effect.Effect<void, Error>[] = [];

            if (options.detachActiveChildren !== true) {
              this.interruptActiveChildren(runId, visited, true, settlements);
            }

            let stopped = rootHandle
              ? this.terminate(
                  rootHandle,
                  visited,
                  options.detachActiveChildren !== true,
                  settlements,
                )
              : false;
            if (!rootHandle) {
              const activation = this.roster.activation(runId);
              if (activation) {
                activation.interrupt();
                stopped = true;
              }
            }
            // A reached handle or child driver owns terminal finalization.
            // Only an ownerless stop needs to write the terminal fact here.
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
   * Whether this run's stop has landed: the fold's own `cancelled`, read from
   * the session's view rather than remembered here. The in-flight token
   * ({@link RunRoster.beginStop}) covers the stop that is still settling, this
   * covers the stop that landed, and a resume that folds the parent back to
   * running reopens admission with nothing to clear.
   */
  private stopFolded(runId: RunId): boolean {
    return this.runView(runId)?.status === RUN_PHASE.CANCELLED;
  }

  /**
   * Refuse a child admitted under a parent whose stop has already folded
   * ({@link stopFolded}), the way the registry's admission refuses one under a
   * session that is closing. The registry asks this after its own roster
   * checks, so a child it already holds is never reached here.
   */
  assertStopNotFolded(parentRunId: RunId, childRunId: RunId): void {
    if (!this.stopFolded(parentRunId)) return;
    throw new Error(
      `Cannot launch child run ${childRunId} under run ${parentRunId}: that run's stop has already folded.`,
    );
  }

  /**
   * Stop every child still registered under a run whose stop has folded,
   * through the same cascade the stop ran at admission. The stop itself
   * handled the children it could see — a child it detached is no longer
   * owned here, so its sever is preserved exactly, and one it interrupted
   * takes the same interrupt again, which its already-latched stop absorbs —
   * so the only child this reaches is one registered in the window between
   * the stop's settlement and the fold ({@link assertStopNotFolded} refuses
   * every later one). The scan itself runs here, at the fold, where the row
   * that closed the window reads its children; the settlements it collects
   * are composed, never run: the caller executes the returned program on the
   * runtime that delivered the fold, and forks the child teardowns it
   * collects, which cannot fail (their recovery is logged inside).
   */
  sweepChildrenOfFoldedStop(runId: RunId): Effect.Effect<void> {
    if (!this.stopFolded(runId)) return Effect.void;
    const settlements: Effect.Effect<void, Error>[] = [];
    this.interruptActiveChildren(runId, new Set(), true, settlements);
    if (settlements.length === 0) return Effect.void;
    return Effect.forkDetach(
      Effect.all(settlements, { concurrency: 'unbounded', discard: true }),
    ).pipe(Effect.asVoid);
  }

  /** Interrupt all active subagents of a parent run, including descendants. */
  private interruptActiveChildren(
    parentRunId: RunId,
    visited: Set<string>,
    cascadeChildren: boolean,
    settlements: Effect.Effect<void, Error>[],
  ): void {
    // Preparation and final delivery outlive the engine handle; stop their
    // activation as well as the live run below. The activation is keyed
    // apart from the handle so each is interrupted once per stop.
    for (const activation of this.roster.activeChildActivations(parentRunId)) {
      const key = `activation:${activation.runId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      activation.interrupt();
    }
    for (const handle of this.roster.allHandles()) {
      if (handle.isOwnedBy(parentRunId)) {
        this.terminate(handle, visited, cascadeChildren, settlements);
      }
    }
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
    const activation = this.roster.activation(handle.runId);
    let activationInterrupted = false;
    if (activation && !activation.isDetached()) {
      const key = `activation:${activation.runId}`;
      if (!visited.has(key)) {
        visited.add(key);
        activation.interrupt();
        activationInterrupted = true;
      }
    }
    // The run's stop is its fiber's interruption, settled with the fiber
    // itself. The fiber exists from the instant the run is admitted
    // (`RunRoster.launch` forks inside the lane claim), so a launch has no
    // pre-fiber window a stop could miss, and a handle whose fiber is not
    // registered yet is one the roster's lane has not admitted — the
    // activation arm above or the handle-less `kill` branch is its stop. A
    // child loop's activation already carried the stop into its turns above,
    // so it spends the fiber target before we reach it.
    let interrupted = activationInterrupted;
    if (!activationInterrupted) {
      const fiber = this.roster.fiber(handle.runId);
      if (fiber !== undefined) {
        fiber.interruptUnsafe();
        settlements.push(Fiber.await(fiber).pipe(Effect.asVoid));
        interrupted = true;
      }
    }
    // The delivered stop is the admission, exactly as the handle-less
    // branch of `kill` reports an activation-only stop.
    return interrupted;
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
}
