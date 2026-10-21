/**
 * The session's runs: one owner for everything this process holds for a
 * run and everything a stop does with it.
 *
 * One entry per run records the fiber running it, the tracked handle, the
 * native child loop's activation and the run's serial lane; the entry exists
 * exactly while one of those does, which makes it the single in-process
 * answer to "is a generation of this run live here" (`LiveRun.live`).
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

import { finalizeRun } from '@agent/storage/runLifecycle';
import type { ProcessServices } from '@platform/processRuntime';
import {
  grantsKeptFromRows,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunId,
  type RunPhase,
  type CommitOrdinal,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';
import type { RunStopReason } from '@shared/session/runtimeRequest';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import type { RunHandle } from './RunHandle';
import type { rootRun } from './rootLaunch';
import type { SessionHandle } from './SessionHandle';
import type {
  LiveRun,
  RootLaunch,
  RunsShape,
  RunStop,
  RunStopOptions,
} from './runs';
import type { executeAgent, resumeToolUseFromResumeData } from './executeAgent';
import type { resumeRun } from './resumeRun';

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
const isRunLive = (e: unknown): e is RunLive => e instanceof RunLive;

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
  /** The run that launched this child; its edge is {@link RunRegistry.parentOf}. */
  readonly launchParent: RunId | null;
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
  /** The fork every run starts on: the session's context, never a caller's, since a fork from a tool call reads that call's run services; a child's parent is data (`parentRunId`), not fiber ancestry. */
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, ProcessServices>,
  ) => Fiber.Fiber<A, E>;
  /** The run programs these runs run, given by the session layer: an import
   *  of them here would close a cycle (their tools reach `Runs`). */
  readonly programs: RunPrograms;
  /** No liveness arm of the run is left here: wake it for rows landed since. */
  readonly wake: (runId: RunId, since: CommitOrdinal) => void;
}

/** The run programs: a root launch, a fresh run's turn, a resumed run's
 *  turn (`resumeTurn`), and a whole resume. */
export interface RunPrograms {
  readonly root: typeof rootRun;
  readonly executeAgent: typeof executeAgent;
  readonly resumeTurn: typeof resumeToolUseFromResumeData;
  readonly resume: typeof resumeRun;
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
 *  layer in that session's scope and provided as {@link Runs}. Its members
 *  past {@link RunsShape} are the harness internals' (`registryOf`). */
export class RunRegistry implements RunsShape {
  private readonly entries = new Map<RunId, RunEntry>();
  /** {@link awaitDrained}'s waiters: by run, and `''` for the last entry. */
  private readonly drains = new Map<string, Deferred.Deferred<void>>();
  /** The stops begun for each run, one token apiece, so of two overlapping
   *  stops the first to settle cannot admit a child the second's snapshot
   *  already left behind. */
  private readonly stopping = new Map<RunId, Set<symbol>>();
  /** Children a detach cut before their birth, which has no row to carry
   *  it: added in that detach's afterCommit, read through {@link parentOf}
   *  (the birth job's, and the unborn edge's), removed with the entry. A
   *  marked child is born detached, so once born its rows agree. */
  private readonly unbornDetached = new Set<RunId>();
  /** Steps admitted but not yet started; disposal fails them all at once. */
  private readonly waiting = new Set<Deferred.Deferred<never, Error>>();
  /** The session's child-run concurrency budget, made on first use. */
  private budget: Semaphore.Semaphore | undefined;
  private disposed = false;
  /** Set by {@link stopAll}: the session is closing. */
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

  /** The run programs (`RunRegistryInit.programs`). */
  readonly programs: RunPrograms;
  /** Resume one persisted run on this session (`resumeRun`). */
  readonly resume: RunPrograms['resume'];

  constructor(private readonly init: RunRegistryInit) {
    this.programs = init.programs;
    this.resume = init.programs.resume;
  }

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
      this.unbornDetached.delete(runId);
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

  /** One run this process holds, or every one: a launch still resolving
   *  (a fiber, no handle yet) included, which is what `awaitDrained`
   *  waits on and a close stops and, past its budget, settles. */
  // cast: the overloads RunsShape names, answered by one body.
  readonly get = ((runId?: RunId) =>
    runId === undefined
      ? [...this.entries.keys()].flatMap((id) => this.liveRun(id) ?? [])
      : this.liveRun(runId)) as RunsShape['get'];

  private liveRun(runId: RunId): LiveRun | undefined {
    const entry = this.entries.get(runId);
    if (entry === undefined) return undefined;
    const { handle, stopReason } = entry;
    const [live, parent] = [this.isLive(runId), this.parentOf(runId)];
    const drained = this.awaitDrained(runId);
    const controls = handle?.controls;
    return { runId, handle, controls, live, parent, stopReason, drained };
  }

  /** Whether this process holds a live generation of the run: its fiber, a
   *  hold, or an admitted launch. A live tool-use loop is not a fourth arm:
   *  it attaches and detaches inside the run program, on the generation's fiber. */
  private isLive(runId: RunId): boolean {
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

  /** The child activations whose edge names `parentRunId`. */
  private activations(parentRunId: RunId): ChildRunActivation[] {
    return [...this.entries.values()].flatMap(({ activation }) =>
      activation && this.parentOf(activation.runId) === parentRunId
        ? [activation]
        : [],
    );
  }

  /** The children one parent's detach covers: each retained run (handle
   *  or activation) whose edge names it, once. */
  private childRunIds(parentRunId: RunId): readonly RunId[] {
    return [...this.entries.keys()].filter(
      (id) => this.isRetained(id) && this.parentOf(id) === parentRunId,
    );
  }

  /** The run's parent edge here, from its rows: the settled view's for a
   *  run it holds; an unborn one's launch's, unless a detach cut it. A
   *  decision that writes reads the run's records in its job instead. */
  readonly parentOf = (runId: RunId): RunId | null => {
    const run = this.init.session().view.run(runId);
    if (run !== undefined) return run.parentId;
    if (this.unbornDetached.has(runId)) return null;
    const entry = this.entries.get(runId);
    return (
      entry?.activation?.launchParent ?? entry?.handle?.launchParent ?? null
    );
  };

  hasActiveChildren = (parentRunId: RunId): boolean =>
    this.childRunIds(parentRunId).length > 0;

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
      return this.activations(runId).some((a) => a.retainsTerminalParent)
        ? { kind: 'queue' }
        : { kind: 'no_session', runStatus: status };
    }

    if (this.entries.get(runId)?.handle?.controls) return { kind: 'active' };

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
    if (!this.disposed && !this.closing) return undefined;
    const when = this.disposed ? 'after session disposal' : 'while closing';
    const message = `Cannot register run work ${when}.`;
    return new RunAdmissionClosed({ message });
  }

  /** {@link closedRefusal} for the synchronous admissions, which throw it. */
  private assertActive(): void {
    const refused = this.closedRefusal();
    if (refused) throw refused;
  }

  /**
   * Refuse a child admitted under a parent whose stop has begun or folded
   * (the view's `cancelled`). A child held here already answers by its
   * edge now ({@link parentOf}), so one a detach cut is admitted as a root,
   * and is not refused while the stop runs: it is one being severed.
   */
  private assertAdmitsChild(launchParent: RunId, childRunId: RunId): void {
    const parentRunId = this.isRetained(childRunId)
      ? this.parentOf(childRunId)
      : launchParent;
    if (parentRunId === null) return;
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

  /** A root launch (`programs.root`, awaited), or a hold on a stopped
   *  run ({@link hold}). */
  // cast: the overloads RunsShape names, answered by one body.
  readonly launch = ((spec: RootLaunch | { readonly hold: RunId }) =>
    'hold' in spec
      ? this.hold(spec.hold)
      : this.programs.root(spec.request, {
          ...spec.options,
          session: this.init.session(),
        })) as RunsShape['launch'];

  /** The one launch door: every run starts here, on the session's context
   *  ({@link fork}), after earlier work on its lane. It refuses with
   *  `RunLive` as it claims; a surviving claim lifts the stop marks. */
  start<A, E, R extends AgentRunServices, B, E2>(
    runId: RunId,
    program: Effect.Effect<A, E, R>,
    settle: (
      admitted: Effect.Effect<A, E | Error, R>,
    ) => Effect.Effect<B, E2, R>,
  ): Effect.Effect<Fiber.Fiber<B, E2>> {
    return this.fork(settle(this.admit(runId, program, false)));
  }

  /** {@link start}'s fork, admitting no run: a resume attempt admits its own. */
  readonly fork = <A, E>(program: Effect.Effect<A, E, AgentRunServices>) =>
    Effect.sync(() =>
      this.init.fork(program.pipe(Effect.provideService(Runs, this))),
    );

  /** Reserve an inactive run for deletion; never wait for a live owner. */
  withInactiveRunStep<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    return this.admit(runId, operation, true);
  }

  /** Run `operation` on `runId`'s lane: claim the lane synchronously, fork
   *  the operation registered on the entry from its first step, and hold
   *  the lane until that fiber settles, finalizers included. The claim is
   *  conditional: {@link isLive} reads the entry in the same synchronous step
   *  as the tail swap, so this is the one admission. `inactiveStep` marks an
   *  inactive-run step rather than a generation: it also refuses on retained
   *  owners and lane holders, and stays out of {@link isLive}. A step waiting
   *  for its predecessor is refusable where it stands ({@link waiting}) and
   *  hands the lane on when interrupted. */
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
      let since: CommitOrdinal | undefined;
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
        since = this.init.session().log.now();
        return undefined;
      };
      const leave = (): void => {
        this.waiting.delete(refusal);
        const entry = counted;
        counted = undefined;
        if (entry === undefined) return;
        entry.launches -= 1;
        this.prune(runId, entry);
        if (since !== undefined && !this.isLive(runId))
          this.init.wake(runId, since);
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

  /** Hold an inactive run for the caller's scope, refusing a live owner as an
   *  inactive-run step does ({@link withInactiveRunStep}): an idle fiber on
   *  the entry, which {@link isLive} reports and no stop reaches, carrying
   *  the run's DB claim in its own scope, so one construct fences both. */
  private hold(runId: RunId): Effect.Effect<void, Error, Scope.Scope> {
    return Effect.suspend(() => {
      const refused = this.closedRefusal();
      if (refused) return Effect.fail(refused);
      return Effect.asVoid(
        Effect.acquireRelease(
          Effect.gen({ self: this }, function* () {
            const since = this.init.session().log.now();
            const ready = Deferred.makeUnsafe<void, Error>();
            const latch = yield* Latch.make(false);
            const hold = Effect.scoped(
              Effect.gen({ self: this }, function* () {
                yield* this.init.session().log.hold(runId);
                yield* Deferred.succeed(ready, undefined);
                yield* Latch.await(latch);
              }),
            ).pipe(Effect.catch((error) => Deferred.fail(ready, error)));
            // Registered as its first step, as in `admit`; scoped, not a child,
            // so the hold outlives the fiber that took it until the scope closes.
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
            return { latch, fiber, since };
          }),
          // The join awaits the claim release before the caller's scope
          // closes; the hold was the run's liveness, so its end owes the wake.
          ({ latch, fiber, since }) =>
            Latch.open(latch).pipe(
              Effect.andThen(Fiber.join(fiber)),
              Effect.andThen(
                Effect.sync(() => {
                  if (!this.isLive(runId)) this.init.wake(runId, since);
                }),
              ),
            ),
        ),
      );
    });
  }

  /** The session's one child-run concurrency budget: the cap on concurrently
   *  live native child model conversations (`childRunBudget.ts` holds the
   *  design and the configured value). Made at `permits` on first call and
   *  re-pinned on every later one, so a settings change takes effect at the
   *  next child launch and sharing loops pick it up on their next turn. */
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
    if (handle.launchParent !== null)
      this.assertAdmitsChild(handle.launchParent, handle.runId);
    this.entryFor(handle.runId).handle = handle;
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
    if (this.entries.get(activation.runId)?.activation) return () => {};
    if (activation.launchParent !== null)
      this.assertAdmitsChild(activation.launchParent, activation.runId);
    this.entryFor(activation.runId).activation = activation;
    return () => {
      const current = this.entries.get(activation.runId);
      if (current?.activation !== activation) return;
      current.activation = undefined;
      this.prune(activation.runId, current);
    };
  }

  // ------------------------------------------------------------------ stop

  /** The run's fiber, interrupted by run id: synchronous, answered at once
   *  from every host surface. The fiber-only primitive a child loop's own
   *  interrupt composes; others stop via {@link interruptActive}, {@link stop}. */
  interrupt(runId: RunId): boolean {
    const fiber = this.entries.get(runId)?.fiber;
    if (fiber === undefined) return false;
    fiber.interruptUnsafe();
    return true;
  }

  /** Stop whatever of the run is live here, by run id: a reserved child-loop
   *  activation (its interrupt aborts the foreign turn's signal and, for a
   *  native child, the run's fiber with it), else the run's fiber itself. */
  interruptActive(runId: RunId): boolean {
    const activation = this.entries.get(runId)?.activation;
    if (activation === undefined) return this.interrupt(runId);
    activation.interrupt();
    return true;
  }

  /**
   * Stop a run and apply the caller's declared child policy. A run this
   * process drives is stopped where it stands: its children first, by the
   * policy, then its handle or child driver. A cascading stop does that now,
   * so {@link RunStop.accepted} answers at once; a detaching one commits the
   * children's durable `run.detach` batch first, or a child completing while
   * that batch commits would route its terminal result to the just-stopped
   * parent. A run no handle or child driver here owns is stopped from
   * outside: its claim fences the whole gesture, descendant sweep included,
   * and the stop writes the terminal row itself; a refused row fails it.
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
      const root = this.entries.get(runId)?.handle;
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
            // only an ownerless stop writes the terminal fact here, as an
            // inactive-run step: a generation admitted meanwhile (a resume
            // here) refuses it with `RunLive` and becomes the stop's target
            // and its lifecycle's one writer. An ended run keeps its verdict.
            stopHere()
              ? Effect.void
              : this.withInactiveRunStep(
                  runId,
                  finalizeRun(this.init.session(), {
                    runId,
                    outcome: RUN_OUTCOME.CANCELLED,
                    keepExistingOutcome: true,
                  }),
                ).pipe(
                  Effect.catchIf(isRunLive, () => Effect.sync(stopHere)),
                  Effect.asVoid,
                ),
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

  /** The session is closing: refuse every run registered from here on, and
   *  stop every run no other run here stops, cascading into its children (a
   *  child whose parent this registry holds is stopped by that parent's
   *  cascade; every other run is stopped itself). Answers the runs left for
   *  the caller to settle: those no live target took the stop for, since
   *  nothing here drives them, and those whose stop failed to record what it
   *  owed storage (logged here). Stopped runs keep their records until they
   *  settle ({@link awaitDrained}). */
  stopAll(): Effect.Effect<readonly RunId[]> {
    this.closing = true;
    const shutdown = {
      detachActiveChildren: false,
      reason: 'shutdown',
    } as const;
    const active = new Set(this.entries.keys());
    const stops = [...active].flatMap((runId) => {
      const parent = this.parentOf(runId);
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

  /** One `run.end` this process committed, from the session's fold-gated tail
   *  once the view has folded it: a run that ended `cancelled` closes the
   *  admission window its stop left, so this interrupts the children admitted
   *  between the stop's settlement and the fold — every later one
   *  {@link assertAdmitsChild} refuses. Each interrupted driver settles its run. */
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

  /** Interrupt all active subagents of a parent run, including descendants. */
  private interruptActiveChildren(
    parentRunId: RunId,
    visited: Set<string>,
    reason: RunStopReason | undefined,
  ): void {
    // Preparation and final delivery outlive the engine handle: stop their
    // activation too, keyed apart from the handle so each is interrupted once.
    for (const activation of this.activations(parentRunId)) {
      const key = `activation:${activation.runId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      this.markStopped(activation.runId, reason);
      activation.interrupt();
    }
    for (const { handle } of this.entries.values())
      if (handle && this.parentOf(handle.runId) === parentRunId)
        this.terminate(handle, visited, true, reason);
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

  // ---------------------------------------------------------------- detach

  /**
   * Detach all active subagents from a parent, promoting them to top-level:
   * they keep running and deliver through the follow-up queue. One job
   * decides which children are born and severs those durably (their claims
   * held), keeping the grants each inherited. The unborn ones have no row to
   * carry it: once the batch commits (a refused one cuts none), before the
   * publisher runs any birth job, they are marked {@link unbornDetached},
   * which their birth job reads (`openRun`): a child is born detached, or
   * detached by rows. The stop marked the parent before reading its
   * children, so none is admitted in between.
   */
  private detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    const session = this.init.session();
    return session.log.transact((tx) =>
      Effect.gen({ self: this }, function* () {
        const children = this.childRunIds(parentRunId);
        const view = SubscriptionRef.getUnsafe(session.view.ref);
        // Each born child's kept grants, from its rows: the view may not
        // hold a child born a moment ago.
        const kept = new Map<RunId, ApprovalGrants>();
        for (const id of children) {
          const rows = yield* session.log.rows(qualifyAggregateId('run', id), [
            'run.start',
            'approval.policy',
          ]);
          const grants = grantsKeptFromRows(view, id, parentRunId, rows);
          if (grants === undefined) continue;
          kept.set(id, grants);
          yield* session.log.hold(id);
        }
        if (kept.size > 0)
          yield* tx.append(
            [...kept].flatMap(([id, snapshot]) => {
              const aggregateId = qualifyAggregateId('run', id);
              return [
                { type: 'run.detach', aggregateId },
                { type: 'approval.policy', aggregateId, snapshot },
              ] as const;
            }),
          );
        // Only a child still here: one gone since has no birth left to cut.
        yield* tx.afterCommit(
          Effect.sync(() => {
            for (const id of children)
              if (!kept.has(id) && this.entries.has(id))
                this.unbornDetached.add(id);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  // ----------------------------------------------------------------- close

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
 * The session's runs ({@link RunsShape}). Built by the session layer in the
 * session's scope and disposed when that scope closes (`sessionLayer.ts`);
 * the session record carries the same value (`SessionHandle.runs`) for a
 * host that holds the session. Effect code below a launch takes it from
 * context.
 */
export class Runs extends Context.Service<Runs, RunsShape>()(
  '@texra-ai/harness/session/Runs',
) {}

/** The registry behind a session's runs: harness internals only, the files
 *  `runRegistryAccessRatchet` names. */
export const registryOf = (runs: RunsShape): RunRegistry =>
  // cast: the session layer builds every session's runs as a RunRegistry.
  runs as RunRegistry;

/**
 * The services every step of an agent run reads on the way down: the process
 * services and the `Runs` of the session the run is launched on.
 */
export type AgentRunServices = ProcessServices | Runs;
