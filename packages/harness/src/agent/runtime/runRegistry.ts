/**
 * The session's runs: one owner for everything this process holds for a
 * run and everything a stop does with it.
 *
 * One entry per run records the fiber running it, the tracked handle, the
 * activation its launch opened and the run's serial lane; the entry exists
 * exactly while one of those does, which makes it the single in-process
 * answer to "is a generation of this run live here" (`LiveRun.live`).
 * Admission, stop, deletion and follow-up routing all read that one record.
 * Serialization is `withPerKeyLane`: FIFO admission with an interruptible wait,
 * its lane kept on the entry.
 */

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Latch,
  Schema,
  type Scope,
  Semaphore,
  SubscriptionRef,
} from 'effect';

import { finalizeRun } from '@agent/storage/runLifecycle';
import type { ProcessServices } from '@platform/processRuntime';
import { grantsKept, type ApprovalGrants } from '@shared/approvalBypassKind';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
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
export class RunLive extends Schema.TaggedError<RunLive>()('RunLive', {
  runId: Schema.String,
}) {
  override readonly message = `Run is already running: ${this.runId}`;
}
const isRunLive = (e: unknown): e is RunLive => e instanceof RunLive;

/** Run work refused because the session is disposed or closing. */
class RunAdmissionClosed extends Schema.TaggedError<RunAdmissionClosed>()(
  'RunAdmissionClosed',
  { message: Schema.String },
) {}

/**
 * What the session hands its runs. They read a run's phase from the
 * session's fold (`RunView.status`) and keep no phase of their own; a stop
 * in progress is its activation's `stopReason` until the fold shows the run
 * cancelled.
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
  /** No liveness arm of the run is left here: wake it for the input it
   *  holds (`Inbox.wake`). */
  readonly wake: (runId: RunId) => void;
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
  /** The launch in flight ({@link RunRegistry.start}), from the call until
   *  its fiber exits: a run's whole life here, setup and end included. */
  activation?: {
    /** The edge of a run not yet created: its launch's, cut by a detach
     *  that commits before it is ({@link RunRegistry.bornDetached}), which
     *  no row carries; created detached, its rows then agree. */
    unbornParent: RunId | null;
    /** The stop begun for it, recorded at the request, before the
     *  interrupt, for its cleanup (a `user` reason outlives a later
     *  `shutdown`) and for child admission ({@link RunRegistry.assertAdmitsChild}). */
    stopReason?: RunStopReason;
    /** A stop reached it: one its program had not started is interrupted
     *  as it starts. */
    stopped: boolean;
  };
  /** The run's hand-off chain while a fiber holds or waits on it. */
  lane?: PerKeyLane;
  /** Fibers of this run holding or waiting on that lane; an inactive-run
   *  step takes the lane without being one ({@link RunRegistry.isLive}). */
  launches: number;
}

/** Session-owned registry of runs: one per session, built by the session
 *  layer in that session's scope and provided as {@link Runs}. Its members
 *  past {@link RunsShape} are the harness internals' (`registryOf`). */
export class RunRegistry implements RunsShape {
  private readonly entries = new Map<RunId, RunEntry>();
  /** {@link awaitDrained}'s waiters: by run, and `''` for the last entry. */
  private readonly drains = new Map<string, Deferred.Deferred<void>>();
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

  private readonly init: RunRegistryInit;
  constructor(init: RunRegistryInit) {
    this.init = init;
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
    const { handle } = entry;
    const live = this.isLive(runId);
    const drained = this.awaitDrained(runId);
    const controls = handle?.controls;
    const readsMessages =
      controls !== undefined
        ? !controls.oneShot
        : this.init.session().view.run(runId)?.followUpSupport !==
          USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
    return {
      runId,
      handle,
      controls,
      live,
      readsMessages,
      stopReason: entry.activation?.stopReason,
      drained,
    };
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

  /** A handle or a launch this session still retains for `runId`. */
  private isRetained(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    return entry?.handle !== undefined || entry?.activation !== undefined;
  }

  /** Whether any fiber holds or waits on `runId`'s lane, step or generation. */
  private isLaneOccupied(runId: RunId): boolean {
    return (this.entries.get(runId)?.lane?.fibers ?? 0) > 0;
  }

  /** The children one parent's detach or stop covers: each retained run
   *  (handle or launch) whose edge names it, once. */
  private childRunIds(parentRunId: RunId): readonly RunId[] {
    return [...this.entries.keys()].filter(
      (id) => this.isRetained(id) && this.attachedParent(id) === parentRunId,
    );
  }

  /** The run's attached parent here: the settled view's for a run that
   *  exists, its activation's for one not yet created. A decision that
   *  writes reads the run's records in its job instead. */
  private attachedParent(runId: RunId): RunId | null {
    const run = this.init.session().view.run(runId);
    return run
      ? run.parentId
      : (this.entries.get(runId)?.activation?.unbornParent ?? null);
  }

  /** A detach cut the run before it was created: its birth is a root's. */
  bornDetached(runId: RunId): boolean {
    return this.entries.get(runId)?.activation?.unbornParent === null;
  }

  hasActiveChildren = (parentRunId: RunId): boolean =>
    this.childRunIds(parentRunId).length > 0;

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
   * edge now ({@link attachedParent}), so one a detach cut is admitted as a
   * root, and is not refused while the stop runs: it is one being severed.
   */
  private assertAdmitsChild(launchParent: RunId, childRunId: RunId): void {
    const parentRunId = this.isRetained(childRunId)
      ? this.attachedParent(childRunId)
      : launchParent;
    if (parentRunId === null) return;
    const stopping =
      this.entries.get(parentRunId)?.activation?.stopReason !== undefined;
    if (stopping && this.isRetained(childRunId)) return;
    if (stopping || this.stopFolded(parentRunId))
      throw new Error(
        `Cannot launch child run ${childRunId} under run ${parentRunId}: that run was stopped.`,
      );
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
   *  ({@link fork}), after earlier work on its lane. Its activation opens
   *  at the call, so a stop finds it from then on, and closes with its
   *  fiber; a child names the run that launched it, and is refused under
   *  a stopped one. It refuses with `RunLive` as it claims. */
  start<A, E, R extends AgentRunServices, B, E2>(
    runId: RunId,
    program: Effect.Effect<A, E, R>,
    settle: (
      admitted: Effect.Effect<A, E | Error, R>,
    ) => Effect.Effect<B, E2, R>,
    launchParent: RunId | null = null,
  ): Effect.Effect<Fiber.Fiber<B, E2>> {
    return Effect.suspend(() => {
      if (launchParent !== null) this.assertAdmitsChild(launchParent, runId);
      const entry = this.entryFor(runId);
      // A launch live here keeps its activation: this one is refused.
      const own = entry.activation
        ? undefined
        : { unbornParent: launchParent, stopped: false };
      entry.activation ??= own;
      return Effect.tap(
        this.fork(settle(this.admit(runId, program, false))),
        (fiber) =>
          Effect.sync(() =>
            fiber.addObserver(() => {
              if (own === undefined || entry.activation !== own) return;
              entry.activation = undefined;
              this.prune(runId, entry);
            }),
          ),
      );
    });
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
      const refuseClaim = (): RunLive | undefined => {
        const held =
          inactiveStep &&
          (this.isRetained(runId) || this.isLaneOccupied(runId));
        if (this.isLive(runId) || held) return new RunLive({ runId });
        if (inactiveStep) return undefined;
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
        if (!this.isLive(runId)) this.init.wake(runId);
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
        // A stop that reached the launch before its program ran.
        if (!inactiveStep && this.entries.get(runId)?.activation?.stopped)
          fiber.interruptUnsafe();
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
            return { latch, fiber };
          }),
          // The join awaits the claim release before the caller's scope
          // closes; the hold was the run's liveness, so its end owes the wake.
          ({ latch, fiber }) =>
            Latch.open(latch).pipe(
              Effect.andThen(Fiber.join(fiber)),
              Effect.andThen(
                Effect.sync(() => {
                  if (!this.isLive(runId)) this.init.wake(runId);
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

  /** Register a run handle, a child's refused under a stopped parent. */
  track(handle: RunHandle): void {
    this.assertActive();
    const parent = this.entries.get(handle.runId)?.activation?.unbornParent;
    if (parent) this.assertAdmitsChild(parent, handle.runId);
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

  // ------------------------------------------------------------------ stop

  /** Stop the run's launch here by run id: synchronous, answered at once
   *  from every host surface. The stop is recorded on its activation (a
   *  program not yet running is interrupted as it starts) and its fiber
   *  interrupted; a stop's reason is {@link markStopped}'s. */
  interrupt(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (entry?.activation) entry.activation.stopped = true;
    entry?.fiber?.interruptUnsafe();
    return entry?.activation !== undefined || entry?.fiber !== undefined;
  }

  /**
   * Stop a run by the caller's child policy. A run this process drives is
   * stopped where it stands, children first: a cascading stop now, so
   * {@link RunStop.accepted} answers at once; a detaching one after the
   * children's `run.detach` batch commits, or a child completing meanwhile
   * would route its result to the just-stopped parent. A run nothing here
   * owns is stopped under its claim, descendants swept, the terminal row
   * written here; a refused row fails it.
   */
  stop(runId: RunId, options: RunStopOptions): RunStop {
    const entry = this.entries.get(runId);
    // Marked at the request: from here a child is refused under the run
    // (`assertAdmitsChild`) and a user's message sent while the stop runs
    // waits for the run to drain (`submitFollowUp`); a failed stop unmarks.
    const marked = entry?.activation?.stopReason;
    if (entry !== undefined) this.markStopped(runId, options.reason);

    const detach = options.detachActiveChildren === true;
    // Something here to stop: a handle, a child driver, or a launch's fiber.
    const local = this.isRetained(runId) || entry?.fiber !== undefined;
    let reached = false;
    const stopHere = (): boolean => {
      // Shared by the child sweep and the root cascade: each run once.
      const visited = new Set<string>();
      reached = this.terminate(runId, visited, !detach, options.reason);
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
            // A reached target finalizes itself; an ownerless stop writes the
            // terminal row as an inactive-run step, which a generation admitted
            // meanwhile refuses (`RunLive`) and becomes the target instead.
            stopHere()
              ? Effect.void
              : this.withInactiveRunStep(
                  runId,
                  finalizeRun(this.init.session(), {
                    runId,
                    outcome: RUN_OUTCOME.CANCELLED,
                    ownerless: true,
                  }),
                ).pipe(
                  Effect.catchIf(isRunLive, () => Effect.sync(stopHere)),
                  Effect.asVoid,
                ),
          ),
        ),
        // Refused before anything was stopped: the run goes on, unmarked.
        Effect.tapError(() =>
          Effect.sync(() => {
            const current = this.entries.get(runId);
            if (!reached && current?.activation)
              current.activation.stopReason = marked;
          }),
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
    return { accepted: () => reached, settlement };
  }

  /** The session is closing: refuse every run registered from here on, and
   *  stop every run whose parent this registry does not hold (that parent's
   *  cascade stops the rest). Answers the runs left for the caller to settle:
   *  those no live target took the stop for, and those whose stop failed to
   *  record what it owed storage (logged here). Stopped runs keep their
   *  records until they settle ({@link awaitDrained}). */
  stopAll(): Effect.Effect<readonly RunId[]> {
    this.closing = true;
    const shutdown = {
      detachActiveChildren: false,
      reason: 'shutdown',
    } as const;
    const active = new Set(this.entries.keys());
    const stops = [...active].flatMap((runId) => {
      const parent = this.attachedParent(runId);
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

  /** Record why `runId` stops, before it is interrupted, on its activation;
   *  only a run this process launched has one. */
  private markStopped(runId: RunId, reason: RunStopReason | undefined): void {
    const activation = this.entries.get(runId)?.activation;
    if (activation === undefined || reason === undefined) return;
    if (activation.stopReason !== 'user') activation.stopReason = reason;
  }

  /** Stop `runId` here, its children first when `cascadeChildren`: each run
   *  once. A child run is its loop, not only the turn its handle runs, so
   *  its interrupted turn is not delivered to the parent as a completed one. */
  private terminate(
    runId: RunId,
    visited: Set<string>,
    cascadeChildren: boolean,
    reason: RunStopReason | undefined,
  ): boolean {
    if (visited.has(runId)) return false;
    visited.add(runId);
    if (cascadeChildren)
      for (const child of this.childRunIds(runId))
        this.terminate(child, visited, true, reason);
    this.markStopped(runId, reason);
    return this.interrupt(runId);
  }

  // ---------------------------------------------------------------- detach

  /**
   * Detach all active subagents from a parent, promoting them to top-level:
   * they keep running and deliver through the follow-up queue. One job
   * decides which children are born and severs those durably (their claims
   * held), keeping the grants each inherited. The unborn ones have no row to
   * carry it: once the batch commits (a refused one cuts none), before the
   * publisher runs any birth job, their activations are cut, which their
   * birth job reads ({@link bornDetached}): a child is born detached, or
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
          const facts = yield* session.log.facts(id);
          if (facts?.start == null || facts.grants === null) continue;
          const parent = facts.start.parent?.id ?? parentRunId;
          kept.set(id, grantsKept(view, id, parent, facts.grants));
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
        yield* session.log.afterCommit(
          Effect.sync(() => {
            for (const id of children)
              if (!kept.has(id)) {
                const activation = this.entries.get(id)?.activation;
                if (activation) activation.unbornParent = null;
              }
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
