/**
 * The session's runs: one owner for everything this process holds for a
 * run and everything a stop does with it.
 *
 * One entry per run records the fiber running it, the tracked handle, the
 * native child loop's activation and the run's serial lane; the entry exists
 * exactly while one of those does, which makes it the single in-process
 * answer to "is a generation of this run live here" ({@link RunRegistry.isLive}).
 * Admission, stop, deletion and follow-up routing all read that one record.
 * Serialization is `withPerKeyLane`: FIFO admission with an interruptible wait,
 * its lane kept on the entry.
 */

import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Latch,
  Semaphore,
  SubscriptionRef,
  type Scope,
} from 'effect';

import {
  finalizeRun,
  type FinalizeRunInput,
  type FinalizeRunResult,
} from '@agent/storage/runLifecycle';
import type { ProcessServices } from '@platform/processRuntime';
import {
  inheritedGrants,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  type RunPhase,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';
import type { RunStopReason } from '@shared/session/runtimeRequest';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import type { RunHandle, RunParent } from './RunHandle';
import type { SessionHandle } from './SessionHandle';
import type { RunStop, RunStopOptions } from './runStop';

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

/** Run work refused because the session is disposed or closing. */
class RunAdmissionClosed extends Data.TaggedError('RunAdmissionClosed')<{
  readonly message: string;
}> {}

/**
 * A child loop's stop target and lineage for the loop's whole life: from the
 * synchronous launch until its final result has reached the parent, including
 * preparation before the engine tracks its handle and terminal delivery after
 * it, so a stop always finds a live target across the inter-turn gap.
 */
export interface ChildRunActivation {
  readonly runId: RunId;
  parent: RunParent;
  readonly interrupt: () => void;
  /**
   * A native child (true) counts as its parent's active child until the last
   * delivery landed, so a terminal parent's continuation stays recoverable
   * ({@link RunRegistry.getToolUseFollowUpTarget} queues a follow-up into
   * it). A process child (false) must not: its reservation would make a
   * terminal parent look recoverable after it can no longer accept either
   * user input or the child's result.
   */
  readonly retainsTerminalParent: boolean;
}

/** Where a follow-up for a run goes: its running loop, the run's retained
 *  queue (a WAITING or resuming cursor, or a parent whose children are still
 *  active), or nowhere in this process. */
export type ToolUseFollowUpTarget =
  | { readonly kind: 'active' }
  | { readonly kind: 'queue' }
  | {
      readonly kind: 'no_session';
      readonly runStatus: RunPhase | undefined;
    };

/**
 * What the session hands its runs. They read a run's phase from the
 * session's fold (`RunView.status`) and keep no phase of their own; the
 * session routes each `run.end` it committed through
 * {@link RunRegistry.sweepChildrenOfFoldedStop} once the view has folded it.
 */
export interface RunRegistryInit {
  /** The session these runs belong to, resolved when first used. */
  readonly session: () => SessionHandle;
  /** The fork every run starts on: the session's context, never a caller's, since a fork from a tool call reads that call's run services (#13348); a child's parent is data (`parentRunId`), not fiber ancestry. */
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, ProcessServices>,
  ) => Fiber.Fiber<A, E>;
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;
/** Everything this process holds for one run. The entry exists exactly while
 *  one of its fields does, which is what makes it the liveness authority. */
interface RunEntry {
  /** The fiber running this run here — its liveness, stop target and terminal
   *  owner — written by that fiber's first step, erased by its own exit. */
  fiber?: AnyFiber;
  hold?: AnyFiber;
  handle?: RunHandle;
  activation?: ChildRunActivation;
  /** The run's hand-off chain while a fiber holds or waits on it. */
  lane?: PerKeyLane;
  /** Fibers of this run holding or waiting on that lane; an inactive-run
   *  step takes the lane without being one ({@link RunRegistry.isLive}). */
  launches: number;
  /** The reason of the stop that interrupted this run here, recorded before
   *  the interrupt so the run's own cleanup reads it. A `user` reason is
   *  never overwritten by a later `shutdown`. */
  stopReason?: RunStopReason;
}

/** Session-owned registry of runs: one per session, built by the session
 *  layer in that session's scope and provided as {@link Runs}. */
export class RunRegistry {
  private readonly entries = new Map<RunId, RunEntry>();
  /** {@link awaitDrained}'s waiters: by run, and `''` for the last entry. */
  private readonly drains = new Map<string, Deferred.Deferred<void>>();
  /** The stops begun for each run, one token apiece, so of two overlapping
   *  stops the first to settle cannot admit a child the second's snapshot
   *  already left behind. */
  private readonly stopping = new Map<RunId, Set<symbol>>();
  /** Steps admitted but not yet started; disposal fails them all at once. */
  private readonly waiting = new Set<Deferred.Deferred<never, Error>>();
  /** The session's child-run concurrency budget, made on first use. */
  private budget: Semaphore.Semaphore | undefined;
  private disposed = false;
  /** Set by {@link close}: the session is closing. */
  private closing = false;
  /** The lane slots `withPerKeyLane` reads and writes: this registry's
   *  entries, so a lane never records a run the entry map lacks. */
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

  constructor(private readonly init: RunRegistryInit) {}

  // ---------------------------------------------------------------- entries

  private entryFor(runId: RunId): RunEntry {
    const existing = this.entries.get(runId);
    if (existing) return existing;
    const entry: RunEntry = { launches: 0 };
    this.entries.set(runId, entry);
    return entry;
  }

  /** Drop an entry that records nothing: the run is not here any more. */
  private prune(runId: RunId, entry: RunEntry): void {
    if (entry.fiber ?? entry.handle ?? entry.activation ?? entry.lane) return;
    if (entry.hold !== undefined || entry.launches > 0) return;
    if (this.entries.get(runId) === entry) {
      this.entries.delete(runId);
      this.completeDrain(runId);
      if (this.entries.size === 0) this.completeDrain('');
    }
  }

  private completeDrain(key: string): void {
    const drained = this.drains.get(key);
    this.drains.delete(key);
    if (drained) Deferred.doneUnsafe(drained, Effect.void);
  }

  /** Register a fiber in `slot` on its entry; its own exit erases it. */
  private setFiber(runId: RunId, fiber: AnyFiber, slot: 'fiber' | 'hold') {
    const entry = this.entryFor(runId);
    entry[slot] = fiber;
    fiber.addObserver(() => {
      if (entry[slot] === fiber) {
        entry[slot] = undefined;
        this.prune(runId, entry);
      }
    });
  }

  // --------------------------------------------------------------- queries

  getHandle(runId: RunId): RunHandle | undefined {
    return this.entries.get(runId)?.handle;
  }

  private handles(): RunHandle[] {
    const handles: RunHandle[] = [];
    for (const entry of this.entries.values())
      if (entry.handle) handles.push(entry.handle);
    return handles;
  }

  /**
   * Every run with an interrupt target: the tracked handles and native child
   * activations still preparing or delivering outside their engine handle.
   * This is what a close stops; {@link awaitDrained} also waits for ownership
   * retained beyond it, through the run's final resource release.
   */
  activeIds(): RunId[] {
    const ids: RunId[] = [];
    for (const [runId, entry] of this.entries)
      if (entry.handle !== undefined || entry.activation !== undefined)
        ids.push(runId);
    return ids;
  }

  /** Every run this session still keeps a record of: what `awaitDrained`
   *  waits on, so what a close stops and, past its budget, settles — a
   *  launch still resolving (a fiber, no handle yet) included. */
  heldIds(): RunId[] {
    return [...this.entries.keys()];
  }

  /** Whether this process holds a live generation of the run: its fiber, a
   *  hold, or an admitted launch. A live tool-use loop is not a fourth arm:
   *  the loop attaches and detaches inside the run program, which runs on
   *  the generation's fiber. */
  isLive(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (entry === undefined) return false;
    return (
      entry.fiber !== undefined ||
      entry.hold !== undefined ||
      entry.launches > 0
    );
  }

  /** A handle or a child activation this session still retains for `runId`. */
  private isRetained(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    return entry?.handle !== undefined || entry?.activation !== undefined;
  }

  /** Whether any fiber holds or waits on `runId`'s lane, step or generation. */
  private isLaneOccupied(runId: RunId): boolean {
    return (this.entries.get(runId)?.lane?.fibers ?? 0) > 0;
  }

  private *activeChildActivations(
    parentRunId: RunId,
  ): Generator<ChildRunActivation> {
    for (const entry of this.entries.values()) {
      const activation = entry.activation;
      if (
        activation !== undefined &&
        activation.parent.current === parentRunId
      ) {
        yield activation;
      }
    }
  }

  /** The children one parent's detach covers. A Set, not an array: a child
   *  detached mid-turn has both a live handle and a ChildRunActivation
   *  under one runId, so both loops reach it and it is severed once. */
  private childRunIds(parentRunId: RunId): readonly RunId[] {
    const childRunIds = new Set<RunId>();
    for (const activation of this.activeChildActivations(parentRunId))
      childRunIds.add(activation.runId);
    for (const handle of this.handles())
      if (handle.isOwnedBy(parentRunId)) childRunIds.add(handle.runId);
    return [...childRunIds];
  }

  hasActiveChildren(parentRunId: RunId): boolean {
    return this.childRunIds(parentRunId).length > 0;
  }

  /** Decide how a tool-use follow-up is admitted, from one registry-owned
   *  snapshot of run status, running loop, and child runs. */
  getToolUseFollowUpTarget(runId: RunId): ToolUseFollowUpTarget {
    const run = this.init.session().view.run(runId);
    const status: RunPhase | undefined =
      run === undefined || run.status === 'ready' ? undefined : run.status;

    if (status !== undefined && !isInFlightPhase(status)) {
      // Only a native child's explicit delivery reservation can retain a
      // terminal parent's continuation. A child-run handle is lifecycle
      // ownership, not authority to revive a parent that already finished.
      for (const activation of this.activeChildActivations(runId)) {
        if (activation.retainsTerminalParent) return { kind: 'queue' };
      }
      return { kind: 'no_session', runStatus: status };
    }

    if (this.getHandle(runId)?.controls) return { kind: 'active' };

    if (
      run?.substate === RUN_SUBSTATE.RESUMING ||
      status === RUN_PHASE.WAITING ||
      this.hasActiveChildren(runId)
    ) {
      return { kind: 'queue' };
    }
    return { kind: 'no_session', runStatus: status };
  }

  // -------------------------------------------------------------- admission

  /** Why this registry admits no run work, or `undefined` while it does. */
  private closedRefusal(): RunAdmissionClosed | undefined {
    if (this.disposed)
      return new RunAdmissionClosed({
        message: 'Cannot register run work after session disposal.',
      });
    if (this.closing)
      return new RunAdmissionClosed({
        message: 'Cannot register run work while the session is closing.',
      });
    return undefined;
  }

  /** {@link closedRefusal} for the synchronous admissions, which throw it. */
  private assertActive(): void {
    const refused = this.closedRefusal();
    if (refused) throw refused;
  }

  /**
   * Refuse a child admitted under a parent whose stop has begun, or whose
   * stop has already folded (the fold's own `cancelled`, read from the
   * session's view rather than remembered here). A child this registry
   * already holds is not an admission — a native child's activation and every
   * live handle it tracks re-enter here while the detach runs, and those are
   * the children the stop is severing, not new ones.
   */
  private assertAdmitsChild(parentRunId: RunId, childRunId: RunId): void {
    if (this.stopping.has(parentRunId)) {
      if (this.isRetained(childRunId)) return;
      throw new Error(
        `Cannot launch child run ${childRunId} under run ${parentRunId} while that run is stopping.`,
      );
    }
    if (this.stopFolded(parentRunId)) {
      throw new Error(
        `Cannot launch child run ${childRunId} under run ${parentRunId}: that run's stop has already folded.`,
      );
    }
  }

  private stopFolded(runId: RunId): boolean {
    return this.init.session().view.run(runId)?.status === RUN_PHASE.CANCELLED;
  }

  /**
   * The one launch door (R2): every run starts here, on the session's context
   * ({@link fork}), after earlier work on its lane. It refuses with `RunLive`
   * as it claims; a surviving claim lifts the stop marks. `settle` wraps it.
   */
  launch<A, E, R extends AgentRunServices, B, E2>(
    runId: RunId,
    program: Effect.Effect<A, E, R>,
    settle: (
      admitted: Effect.Effect<A, E | Error, R>,
    ) => Effect.Effect<B, E2, R>,
  ): Effect.Effect<Fiber.Fiber<B, E2>> {
    return this.fork(settle(this.admit(runId, program, false)));
  }

  /** {@link launch}'s fork, admitting no run: a resume attempt admits its own. */
  readonly fork = <A, E>(program: Effect.Effect<A, E, AgentRunServices>) =>
    Effect.sync(() =>
      this.init.fork(program.pipe(Effect.provideService(Runs, this))),
    );

  /** {@link launch}, awaited: the caller's interruption stops the run. */
  launchRun<A, E, R extends AgentRunServices>(
    runId: RunId,
    program: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error> {
    return Effect.flatMap(
      this.launch(runId, program, (run) => run),
      (fiber) =>
        Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        ),
    );
  }

  /** Reserve an inactive run for deletion; never wait for a live owner. */
  withInactiveRunStep<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return this.admit(runId, operation, true);
  }

  /** Run `operation` on `runId`'s lane: claim the lane synchronously, fork
   *  the operation registered on the entry from its first step, and hold
   *  the lane until that fiber settles, finalizers included.
   *
   *  The claim is conditional: {@link isLive} reads the entry in the same
   *  synchronous step as the tail swap, so this is the one admission.
   *  `inactiveStep` marks an inactive-run step rather than a generation: it
   *  also refuses on retained owners and lane holders, and stays out of
   *  {@link isLive}. A step waiting for its predecessor is refusable where it
   *  stands ({@link waiting}) and hands the lane on when interrupted. */
  private admit<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
    inactiveStep: boolean,
  ): Effect.Effect<A, E | Error, R> {
    return Effect.suspend(() => {
      const refused = this.closedRefusal();
      if (refused) return Effect.fail(refused);
      const refusal = Deferred.makeUnsafe<never, Error>();
      this.waiting.add(refusal);
      // Counted in where the generation claims the lane, out where the step
      // leaves; the entry is captured at the claim, so a stale leave
      // unwinding after `dispose` decrements its own entry.
      let counted: RunEntry | undefined;
      const refuseClaim = (): RunLive | undefined => {
        const held =
          inactiveStep &&
          (this.isRetained(runId) || this.isLaneOccupied(runId));
        if (this.isLive(runId) || held) return new RunLive({ runId });
        if (inactiveStep) return undefined;
        // A new generation is the run starting again: whatever stop the run
        // was marked for belongs to the generation it ended.
        this.stopping.delete(runId);
        counted = this.entryFor(runId);
        counted.stopReason = undefined;
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
        this.waiting.delete(refusal);
        // The fiber registers itself as its first step (the forking fiber
        // may yield first), so a stop by run id reaches it from the first
        // instant; one only scheduled would skip its finalizers on a
        // pre-start interrupt. An inactive-run step is not a generation.
        const fiber = yield* Effect.forkChild(
          inactiveStep
            ? operation
            : Effect.withFiber((self) => {
                this.setFiber(runId, self, 'fiber');
                return operation;
              }),
          { startImmediately: true },
        );
        // An interrupted join interrupts the fiber and awaits its cleanup.
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        );
      });
      return Effect.raceFirst(
        Deferred.await(refusal),
        withPerKeyLane(this.lanes, runId, refuseClaim)(step),
      ).pipe(Effect.ensuring(Effect.sync(leave)));
    });
  }

  /**
   * Hold an inactive run for the caller's scope, refusing a live owner as an
   * inactive-run step does ({@link withInactiveRunStep}). The hold is an idle
   * fiber on the entry, which {@link isLive} reports and no stop reaches,
   * carrying the run's DB claim in its own scope: one construct fences both.
   */
  holdInactiveRun(runId: RunId): Effect.Effect<void, Error, Scope.Scope> {
    return Effect.suspend(() => {
      const refused = this.closedRefusal();
      if (refused) return Effect.fail(refused);
      return Effect.asVoid(
        Effect.acquireRelease(
          Effect.gen({ self: this }, function* () {
            const ready = Deferred.makeUnsafe<void, Error>();
            const latch = yield* Latch.make(false);
            const hold = Effect.scoped(
              Effect.gen({ self: this }, function* () {
                yield* this.init.session().log.hold(runId);
                yield* Deferred.succeed(ready, undefined);
                yield* Latch.await(latch);
              }),
            ).pipe(Effect.catch((error) => Deferred.fail(ready, error)));
            // Registered as its first step, as in `admit`; scoped, not a
            // child, so the hold outlives the fiber that took it until the
            // scope closes.
            const fiber = yield* Effect.forkScoped(
              Effect.withFiber((self) => {
                if (
                  this.isLive(runId) ||
                  this.isRetained(runId) ||
                  this.isLaneOccupied(runId)
                )
                  return Deferred.fail(ready, new RunLive({ runId }));
                this.setFiber(runId, self, 'hold');
                return hold;
              }),
              { startImmediately: true },
            );
            yield* Deferred.await(ready);
            return { latch, fiber };
          }),
          // The join awaits the claim release before the caller's scope closes.
          ({ latch, fiber }) =>
            Latch.open(latch).pipe(Effect.andThen(Fiber.join(fiber))),
        ),
      );
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
    const entry = this.entryFor(handle.runId);
    handle.parentState =
      entry.activation?.parent ??
      entry.handle?.parentState ??
      handle.parentState;
    entry.handle = handle;
  }

  /** Remove `handle` only if it is still the current registration. */
  untrackIfCurrent(handle: RunHandle): boolean {
    const entry = this.entries.get(handle.runId);
    if (entry?.handle !== handle) return false;
    entry.handle = undefined;
    this.prune(handle.runId, entry);
    return true;
  }

  /** Retain a native child loop's lineage until the returned disposer runs,
   *  which the loop does only after its final delivery to the parent. */
  reserveChildActivation(activation: ChildRunActivation): () => void {
    this.assertActive();
    if (this.entries.get(activation.runId)?.activation) {
      return () => {};
    }
    if (activation.parent.current !== null)
      this.assertAdmitsChild(activation.parent.current, activation.runId);
    const entry = this.entryFor(activation.runId);
    activation.parent = entry.handle?.parentState ?? activation.parent;
    entry.activation = activation;
    return () => {
      const current = this.entries.get(activation.runId);
      if (current?.activation !== activation) return;
      current.activation = undefined;
      this.prune(activation.runId, current);
    };
  }

  // ------------------------------------------------------------------ stop

  /**
   * The run's fiber, interrupted by run id. Synchronously callable from every
   * host surface, and answered straight away: the entry has a fiber or it
   * does not. The fiber-only primitive a child loop's own interrupt composes;
   * every other caller stops through {@link interruptActive} or {@link stop}.
   */
  interrupt(runId: RunId): boolean {
    const fiber = this.entries.get(runId)?.fiber;
    if (fiber === undefined) return false;
    fiber.interruptUnsafe();
    return true;
  }

  /**
   * Stop whatever of the run is live here, by run id: the child loop's
   * activation when one is reserved — its interrupt aborts the foreign
   * turn's signal and, for a native child, the run's fiber with it — and
   * the run's fiber itself otherwise.
   */
  interruptActive(runId: RunId): boolean {
    const activation = this.entries.get(runId)?.activation;
    if (activation === undefined) return this.interrupt(runId);
    activation.interrupt();
    return true;
  }

  /**
   * Stop a run and apply the caller's declared child policy: the one stop
   * every surface issues.
   *
   * A run this process drives is stopped where it stands: its children
   * first, by the policy, then its handle or child driver. A cascading stop
   * does that now, so {@link RunStop.accepted} answers at once; a detaching
   * one commits the children's durable `run.detach` batch first, because a
   * child completing while that batch commits would otherwise route its
   * terminal result to the just-stopped parent.
   *
   * A run no handle or child driver here owns is stopped from outside, so
   * its claim fences the whole gesture, descendant sweep included, and the
   * stop writes the terminal row itself; a refused row fails the settlement.
   */
  stop(runId: RunId, options: RunStopOptions): RunStop {
    const token = Symbol('run-stop');
    const tokens = this.stopping.get(runId) ?? new Set<symbol>();
    tokens.add(token);
    this.stopping.set(runId, tokens);
    const lift = Effect.sync(() => {
      const current = this.stopping.get(runId);
      if (current?.delete(token) !== true) return;
      if (current.size === 0) this.stopping.delete(runId);
    });

    const detach = options.detachActiveChildren === true;
    // Something here to stop: a handle, a child driver, or a launch's fiber
    // that has not tracked its handle yet.
    const local =
      this.isRetained(runId) || this.entries.get(runId)?.fiber !== undefined;
    let reached = false;
    const stopHere = (): boolean => {
      // Shared across the child sweep and the root cascade so each run in
      // the chain is interrupted exactly once.
      const visited = new Set<string>();
      const { reason } = options;
      if (!detach) this.interruptActiveChildren(runId, visited, reason);
      this.markStopped(runId, reason);
      const root = this.getHandle(runId);
      reached = root
        ? this.terminate(root, visited, !detach, reason)
        : this.interruptActive(runId);
      return reached;
    };

    let settlement: Effect.Effect<void, Error>;
    if (local && !detach) {
      stopHere();
      settlement = Effect.void;
    } else {
      const apply = (
        detach ? this.detachActiveChildren(runId) : Effect.void
      ).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            // A reached handle or child driver owns terminal finalization;
            // only an ownerless stop writes the terminal fact here.
            stopHere() ? Effect.void : this.finalizeOwnerlessStop(runId),
          ),
        ),
      );
      settlement = local
        ? apply
        : Effect.scoped(
            this.init
              .session()
              .log.hold(runId, { ends: true })
              .pipe(Effect.andThen(apply)),
          );
    }
    return {
      accepted: () => reached,
      settlement: settlement.pipe(Effect.ensuring(lift)),
    };
  }

  /** Stop every run no other run here stops, cascading into its children:
   *  the sweep a session close runs. A child whose parent this registry holds
   *  is stopped by that parent's cascade; every other run — a root, or a
   *  child whose parent is not here — is stopped itself. Answers the runs
   *  left for the caller to settle: those no live target took the stop for,
   *  since nothing here drives them, and those whose stop failed to record
   *  what it owed storage (logged here). */
  stopAll(): Effect.Effect<readonly RunId[]> {
    const shutdown = {
      detachActiveChildren: false,
      reason: 'shutdown',
    } as const;
    const active = new Set(this.heldIds());
    const stops = [...active].flatMap((runId) => {
      const parent = this.getHandle(runId)?.parent ?? null;
      return parent !== null && active.has(parent)
        ? []
        : [{ runId, stop: this.stop(runId, shutdown) }];
    });
    return Effect.forEach(
      stops,
      ({ runId, stop }) =>
        stop.settlement.pipe(
          Effect.as(stop.accepted() ? [] : [runId]),
          Effect.catchCause((cause) =>
            Effect.logWarning(`The stop of run ${runId} failed`).pipe(
              Effect.annotateLogs({ data: Cause.squash(cause) }),
              Effect.as([runId]),
            ),
          ),
        ),
      { concurrency: 'unbounded' },
    ).pipe(Effect.map((left) => left.flat()));
  }

  /**
   * One `run.end` this process committed, from the session's fold-gated tail
   * once the view has folded it: a run that ended `cancelled` closes the
   * admission window its stop left, so this interrupts the children admitted
   * in the window between the stop's settlement and the fold — every later
   * one {@link assertAdmitsChild} refuses. Each interrupted driver settles
   * its own run.
   */
  sweepChildrenOfFoldedStop(runId: RunId): void {
    if (this.disposed || !this.stopFolded(runId)) return;
    // The folded stop's reason is not known here: its children are
    // interrupted without one, so none cancels remote work.
    this.interruptActiveChildren(runId, new Set(), undefined);
  }

  /** Record why `runId` stops, before it is interrupted (see
   *  {@link RunEntry.stopReason}); only a run this process holds has one. */
  private markStopped(runId: RunId, reason: RunStopReason | undefined): void {
    const entry = this.entries.get(runId);
    if (entry === undefined || reason === undefined) return;
    if (entry.stopReason !== 'user') entry.stopReason = reason;
  }

  /** Why the run was stopped here, while it unwinds from that stop. */
  stopReason(runId: RunId): RunStopReason | undefined {
    return this.entries.get(runId)?.stopReason;
  }

  /** Interrupt all active subagents of a parent run, including descendants. */
  private interruptActiveChildren(
    parentRunId: RunId,
    visited: Set<string>,
    reason: RunStopReason | undefined,
  ): void {
    // Preparation and final delivery outlive the engine handle; stop their
    // activation as well as the live run below. The activation is keyed
    // apart from the handle so each is interrupted once per stop.
    for (const activation of this.activeChildActivations(parentRunId)) {
      const key = `activation:${activation.runId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      this.markStopped(activation.runId, reason);
      activation.interrupt();
    }
    for (const handle of this.handles()) {
      if (handle.isOwnedBy(parentRunId))
        this.terminate(handle, visited, true, reason);
    }
  }

  private terminate(
    handle: RunHandle,
    visited: Set<string>,
    cascadeChildren: boolean,
    reason: RunStopReason | undefined,
  ): boolean {
    if (visited.has(handle.runId)) return false;
    visited.add(handle.runId);
    if (cascadeChildren)
      this.interruptActiveChildren(handle.runId, visited, reason);
    this.markStopped(handle.runId, reason);
    // A child run is its loop, not only the turn this handle runs: stopping
    // it ends the loop too, so the interrupted turn is not delivered to the
    // parent as a completed one. A child loop's activation carries the stop
    // into its turns and spends the fiber target; the fiber exists from the
    // instant the run is admitted, so a launch has no pre-fiber window a stop
    // could miss.
    const activation = this.entries.get(handle.runId)?.activation;
    if (activation === undefined) return this.interrupt(handle.runId);
    const key = `activation:${activation.runId}`;
    if (visited.has(key)) return false;
    visited.add(key);
    activation.interrupt();
    return true;
  }

  /** End a run (`finalizeRun`): the one terminal writer, whoever ends it
   *  (its driver, a refused launch, an ownerless stop, a session close).
   *  Never fails: a persistence failure comes back as `ok: false`. */
  end(input: FinalizeRunInput): Effect.Effect<FinalizeRunResult> {
    return Effect.suspend(() => finalizeRun(this.init.session(), input));
  }

  /** The grants a child keeps once its parent edge goes (its detach row):
   *  what it inherits now, its own goal grant kept. */
  private grantsOnDetach(runId: RunId): ApprovalGrants {
    const current = SubscriptionRef.getUnsafe(this.init.session().view.ref);
    return {
      ...inheritedGrants(current, runId),
      goal: current.policy.get(runId)?.goal ?? [],
    };
  }

  /**
   * Write the terminal fact for a stop that reached no live target, through
   * the run's one writer. `keepExistingOutcome` leaves a run that already
   * ended with its own verdict; the checkpoint is preserved, since a cancelled
   * run is exactly the one a user resumes.
   */
  private finalizeOwnerlessStop(runId: RunId): Effect.Effect<void, Error> {
    return this.end({
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

  // ---------------------------------------------------------------- detach

  /**
   * Detach all active subagents from a parent, promoting them to top-level:
   * they keep running and deliver through the follow-up queue. One durable
   * batch severs every child's edge and keeps the grants it inherited, then
   * the local sever follows on the children it committed, so a refused
   * commit leaves both standing for a retry. The stop marked the parent
   * before reading its children, so none is admitted in between. Each row
   * lands on its child's aggregate, so every child's claim is held (holds
   * nest) until the commit and the sever are done.
   */
  private detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      const detachedChildRunIds = this.childRunIds(parentRunId);
      if (detachedChildRunIds.length === 0) return Effect.void;
      return Effect.scoped(
        Effect.forEach(
          detachedChildRunIds,
          (childRunId) => this.init.session().log.hold(childRunId),
          { discard: true },
        ).pipe(
          Effect.andThen(
            this.init.session().log.transact(
              detachedChildRunIds.flatMap((childRunId) => {
                const aggregateId = qualifyAggregateId('run', childRunId);
                const snapshot = this.grantsOnDetach(childRunId);
                return [
                  { type: 'run.detach', aggregateId },
                  { type: 'approval.policy', aggregateId, snapshot },
                ] as const;
              }),
            ),
          ),
          Effect.andThen(
            Effect.sync(() => {
              this.detachChildren(parentRunId, detachedChildRunIds);
            }),
          ),
        ),
      );
    });
  }

  /** Apply parent removal to local handles and approval ancestry without
   *  publishing, over children a durable detach already covers: the batch
   *  a detaching stop committed, or a committed `run.removed`. */
  detachChildren(
    parentRunId: RunId,
    childRunIds: readonly RunId[] = this.childRunIds(parentRunId),
  ): void {
    for (const childRunId of childRunIds) {
      const entry = this.entries.get(childRunId);
      const parent = entry?.activation?.parent ?? entry?.handle?.parentState;
      if (parent?.current === parentRunId) parent.current = null;
    }
  }

  // ----------------------------------------------------------------- close

  /**
   * The session is closing: refuse every run registered from here on. The
   * runs already tracked keep their handles until they settle
   * ({@link awaitDrained}); the close's `stopAll` interrupts each, and a
   * process child's OS process ends with its loop's scope.
   */
  close(): void {
    this.closing = true;
  }

  /** Resolve once every owner of `runId` (or of every run) has left. */
  awaitDrained(runId?: RunId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const key = runId ?? '';
      if (!(runId ? this.entries.has(runId) : this.entries.size))
        return Effect.void;
      const drained = this.drains.get(key) ?? Deferred.makeUnsafe<void>();
      this.drains.set(key, drained);
      return Deferred.await(drained);
    });
  }

  /** Drop every local record at session disposal, refuse every step admitted
   *  but not started, and release a drain waiting on the records. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Error(
      'Cannot register run work after session disposal.',
    );
    for (const refusal of this.waiting) {
      Deferred.doneUnsafe(refusal, Effect.fail(disposal));
    }
    this.waiting.clear();
    this.entries.clear();
    for (const key of [...this.drains.keys()]) this.completeDrain(key);
    this.stopping.clear();
  }
}

/**
 * The session's runs: run admission and lanes, the live handles, the child
 * run registry of one session. Built by the session layer in the session's scope
 * and disposed when that scope closes (`sessionLayer.ts`); the session record
 * carries the same value (`SessionHandle.runs`) for a host that holds the
 * session. Effect code below a launch takes it from context.
 */
export class Runs extends Context.Service<Runs, RunRegistry>()(
  '@texra/session/Runs',
) {}

/**
 * The services every step of an agent run reads on the way down: the process
 * services and the `Runs` of the session the run is launched on.
 */
export type AgentRunServices = ProcessServices | Runs;
