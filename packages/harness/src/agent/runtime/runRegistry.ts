/**
 * The session's runs: one owner for everything this process holds for a
 * run and everything a stop does with it.
 *
 * What this process holds for a run is one activation per run: a launch in
 * flight here, from `start`'s call until the fiber it forked exits, setup
 * and end included. The activation exists exactly that long, so "does this
 * process run it" is one question, `get(runId) !== undefined`, which
 * admission, stop, deletion and follow-up routing all ask, and which the
 * session's view reads as `runsHere`. Serialization is `withPerKeyLane`: a
 * generation and the steps on an inactive run (its deletion) take the run's
 * lane in call order.
 */

import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  type Scope,
  Semaphore,
} from 'effect';

import type { finalizeRun } from '@agent/storage/runLifecycle';
import type { RunAttempt } from '@agent/followUp/ToolUseFollowUp';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  grantSource,
  grantsKept,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import { Settings } from '@shared/config/settings';
import { ancestryRows } from '@shared/session/runRelation';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
  type RunStopReason,
} from '@shared/schemas';
import type { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';

import type {
  LiveRun,
  RunControls,
  RunsShape,
  RunStop,
  StopCause,
} from './runs';
import type { executeAgent } from './executeAgent';
import type { decideResume } from './resumeRun';
import type { RunServices } from './ToolServices';
import type { SessionServices } from './rootLaunch';

/** A launch already has the run here: the one refusal for that fact. Hosts
 *  word it from `message`; a resume reads the tag to report the run
 *  unresumable, not failed. */
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
 * in progress is its activation's `stop` until the fold shows the run
 * cancelled.
 */
export interface RunRegistryInit {
  /** The session's view: each run's parent edge and phase. */
  readonly view: SessionViewAccess['Service'];
  /** The session's log: each run's detach batch. */
  readonly log: SessionLog['Service'];
  /** Tell the session's view which runs are launched here (`runsHere`),
   *  called with the whole set as an activation opens or closes. */
  readonly runsHere: (runIds: readonly RunId[]) => void;
  /** The session's roots: the stop policy's setting slots. */
  readonly roots: WorkspaceRoots;
  /** The fork every run starts on: the session's context, never a caller's, since a fork from a tool call reads that call's run services; a child's parent is data (`parentRunId`), not fiber ancestry. */
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, Exclude<AgentRunServices, Runs>>,
  ) => Fiber.Fiber<A, E>;
  /** The run programs these runs run, given by the session layer: an import
   *  of them here would close a cycle (their tools reach `Runs`). */
  readonly programs: RunPrograms;
  /** Nothing here holds the run any more: wake it for the input it holds
   *  (`wakeIfOwed`). */
  readonly wake: (runId: RunId) => void;
}

/** The run programs: a run's program (fresh or resumed), a resume's
 *  decision, and the end a stop owes a run nothing here ends. */
export interface RunPrograms {
  readonly executeAgent: typeof executeAgent;
  readonly resume: typeof decideResume;
  readonly finalize: typeof finalizeRun;
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;
/** A launch of one run in flight here ({@link RunRegistry.start}): what this
 *  process holds for the run, from the call until `launch` exits. */
interface Activation {
  /** The fiber the launch runs on, whose exit closes the activation; a
   *  deciding resume hands it to the generation it launches. */
  launch: AnyFiber;
  /** What a stop interrupts: the resume's fiber while it decides, the
   *  generation's from its first step. Unset in between, when a stop is
   *  recorded and read as the generation starts ({@link admit}). */
  fiber?: AnyFiber;
  /** The edge of a run not yet created: its launch's, cut by a detach
   *  that commits before it is ({@link RunRegistry.bornDetached}), which
   *  no row carries; created detached, its rows then agree. */
  unbornParent: RunId | null;
  /** The stop begun for it and why, recorded by every stop at the
   *  request, before the interrupt: a program not yet running is
   *  interrupted as it starts, a resume decides nothing, its cleanup reads
   *  why (a `user` stop outlives a later one), and a child is refused
   *  under it ({@link RunRegistry.assertAdmitsChild}). */
  stop?: StopCause;
  /** A resume's, from its call until the activation closes. */
  attempt?: RunAttempt;
  /** The running loop's controls, attached for its life ({@link attachControls}). */
  controls?: RunControls;
}

/** Session-owned registry of runs: one per session, built by the session
 *  layer in that session's scope and provided as {@link Runs}. Its members
 *  past {@link RunsShape} are the harness internals' (`registryOf`). */
export class RunRegistry implements RunsShape {
  private readonly activations = new Map<RunId, Activation>();
  /** The run lanes, each kept while a fiber holds or waits on it. */
  private readonly lanes = new Map<RunId, PerKeyLane>();
  /** The session's child-run concurrency budget, made on first use. */
  private budget: Semaphore.Semaphore | undefined;
  private disposed = false;
  /** Why each run held at disposal was stopping: one still ending past
   *  the close's deadline reads it ({@link stopCause}). */
  private readonly stoppedAtDisposal = new Map<RunId, StopCause>();
  /** Set by {@link stopAll}: the session is closing. */
  private closing = false;

  /** The run programs (`RunRegistryInit.programs`). */
  readonly programs: RunPrograms;

  private readonly init: RunRegistryInit;
  constructor(init: RunRegistryInit) {
    this.init = init;
    this.programs = init.programs;
  }

  // --------------------------------------------------------------- queries

  /** One run this process holds, or every one: a launch still resolving
   *  (no loop yet) included, which is what `awaitDrained`
   *  waits on and a close stops and, past its budget, reports. */
  // cast: the overloads RunsShape names, answered by one body.
  readonly get = ((runId?: RunId) =>
    runId === undefined
      ? [...this.activations.keys()].flatMap((id) => this.liveRun(id) ?? [])
      : this.liveRun(runId)) as RunsShape['get'];

  readonly stopCause = (runId: RunId): StopCause | undefined =>
    this.activations.get(runId)?.stop ?? this.stoppedAtDisposal.get(runId);

  private liveRun(runId: RunId): LiveRun | undefined {
    const activation = this.activations.get(runId);
    if (activation === undefined) return undefined;
    const { controls } = activation;
    const readsMessages =
      controls !== undefined
        ? !controls.oneShot
        : this.init.view.run(runId)?.followUpSupport !==
          USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
    return {
      runId,
      controls,
      readsMessages,
      drained: this.awaitDrained(runId),
    };
  }

  /** The children one parent's detach or stop covers: each launched run
   *  whose edge names it, once. */
  private childRunIds(parentRunId: RunId): readonly RunId[] {
    return [...this.activations.keys()].filter(
      (id) => this.attachedParent(id) === parentRunId,
    );
  }

  /** The run's attached parent here: the settled view's for a run that
   *  exists, its activation's for one not yet created. A decision that
   *  writes reads the run's records in its job instead. */
  attachedParent(runId: RunId): RunId | null {
    const run = this.init.view.run(runId);
    return run
      ? run.parentId
      : (this.activations.get(runId)?.unbornParent ?? null);
  }

  /** A detach cut the run before it was created: its birth is a root's. */
  bornDetached(runId: RunId): boolean {
    return this.activations.get(runId)?.unbornParent === null;
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

  /**
   * Refuse a child admitted under a parent whose stop has begun or folded
   * (the view's `cancelled`). A child held here already answers by its
   * edge now ({@link attachedParent}), so one a detach cut is admitted as a
   * root, and is not refused while the stop runs: it is one being severed.
   */
  private assertAdmitsChild(launchParent: RunId, childRunId: RunId): void {
    const launched = this.activations.has(childRunId);
    const parentRunId = launched
      ? this.attachedParent(childRunId)
      : launchParent;
    if (parentRunId === null) return;
    const stopping = this.activations.get(parentRunId)?.stop !== undefined;
    if (stopping && launched) return;
    const folded = this.init.view.run(parentRunId)?.status;
    if (stopping || folded === RUN_PHASE.CANCELLED)
      throw new Error(
        `Cannot launch child run ${childRunId} under run ${parentRunId}: that run was stopped.`,
      );
  }

  /** The one launch door: every run starts here, on the session's context,
   *  after earlier work on its lane. Its activation opens at the call, so a
   *  stop finds it from then on, and closes with its fiber; a child names
   *  the run that launched it, and is refused under a stopped one. A run
   *  already launched here refuses it with `RunLive`. An `attempt` opens a
   *  resume (`resumeRun`): `program` decides, unadmitted, and hands the
   *  activation to the generation it launches. */
  start<A, E, R extends AgentRunServices, B, E2>(
    runId: RunId,
    program: Effect.Effect<A, E, R>,
    settle: (
      admitted: Effect.Effect<A, E | Error, R | SessionServices>,
    ) => Effect.Effect<B, E2, R | SessionServices>,
    launchParent: RunId | null = null,
    attempt?: RunAttempt,
  ): Effect.Effect<Fiber.Fiber<B, E2>> {
    return Effect.sync(() => {
      if (launchParent !== null) this.assertAdmitsChild(launchParent, runId);
      let own = this.activations.get(runId);
      // A deciding resume hands its activation to the next launch here (its
      // generation, or a parent's reattach), never to a second resume; any
      // other launch keeps it, refusing this one.
      const refused =
        own !== undefined &&
        (attempt !== undefined || own.fiber !== own.launch);
      // Opened on the first of the fiber's first step and `start`'s return:
      // a fork may run its fiber before returning it.
      const opened = (launch: AnyFiber): Activation => {
        if (own === undefined) {
          own = { launch, unbornParent: launchParent, attempt };
          this.activations.set(runId, own);
          this.init.runsHere([...this.activations.keys()]);
          if (attempt) attempt.activation = own;
        } else if (own.launch !== launch) {
          own.launch = launch;
          own.fiber = undefined;
        }
        return own;
      };
      // A stop recorded before a resume's decision ran had no fiber to
      // interrupt: it reads it first. A stop that ended the decision before
      // it admitted a generation owes the run its end ({@link stopEnd}).
      const body = (activation: Activation) =>
        attempt === undefined
          ? this.admit(runId, program, { activation })
          : Effect.suspend(() =>
              activation.stop ? Effect.interrupt : program,
            ).pipe(
              Effect.onExit((exit) =>
                Effect.ignore(
                  (Exit.hasInterrupts(exit) &&
                    !Deferred.isDoneUnsafe(attempt.admitted) &&
                    this.stopEnd(runId, activation.stop)) ||
                    Effect.void,
                  { log: 'Warn', message: `The stop of ${runId} wrote no end` },
                ),
              ),
            );
      // Whether the fiber opened its activation itself: then a launch
      // it handed on meanwhile (a resume decided before the fork returned,
      // its generation launched) is left with its generation.
      let openedOnFiber = false;
      const fiber = this.init.fork(
        Effect.withFiber((self) => {
          if (refused) return settle(Effect.fail(new RunLive({ runId })));
          const activation = opened(self);
          openedOnFiber = true;
          // The resume decides on this fiber: what a stop interrupts.
          if (attempt !== undefined) activation.fiber = self;
          return settle(body(activation));
        }).pipe(Effect.provideService(Runs, this)),
      );
      if (refused) return fiber;
      const activation = openedOnFiber
        ? this.activations.get(runId)
        : opened(fiber);
      if (activation === undefined) return fiber;
      // The last launch's exit closes the activation: a deciding resume
      // whose activation was handed on leaves it to its generation.
      fiber.addObserver(() => {
        if (
          this.activations.get(runId) !== activation ||
          activation.launch !== fiber
        )
          return;
        this.activations.delete(runId);
        this.init.runsHere([...this.activations.keys()]);
        this.init.wake(runId);
      });
      return fiber;
    });
  }

  /** The resume in flight on `runId`'s activation, if a resume opened it. */
  attemptOf(runId: RunId): RunAttempt | undefined {
    return this.activations.get(runId)?.attempt;
  }

  /** Reserve an inactive run for deletion, never waiting for a live owner:
   *  refused where a launch holds the run or any fiber holds or waits on
   *  its lane, both read in the synchronous step that would take the lane. */
  withInactiveRunStep<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    const refuse = (occupant: PerKeyLane | undefined) =>
      this.activations.has(runId) || occupant !== undefined
        ? new RunLive({ runId })
        : undefined;
    return this.admit(runId, operation, { refuse });
  }

  /** Run `operation` on `runId`'s lane: claim the lane synchronously (unless
   *  `refuse` says why not), fork the operation, and hold the lane until
   *  that fiber settles, finalizers included. The generation of an
   *  `activation` registers on it from its first step, and claims under its
   *  launch, which refused every other launch. */
  private admit<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
    step: {
      readonly activation?: Activation;
      readonly refuse?: (
        occupant: PerKeyLane | undefined,
      ) => RunLive | undefined;
    },
  ): Effect.Effect<A, E | Error, R> {
    const { activation, refuse } = step;
    return Effect.suspend(() => {
      const refused = this.closedRefusal();
      if (refused) return Effect.fail(refused);
      const run = Effect.gen({ self: this }, function* () {
        // Disposed or closing while this step waited for its predecessor.
        const closed = this.closedRefusal();
        if (closed) return yield* Effect.fail(closed);
        // The generation registers itself as its first step (the forking
        // fiber may yield first), so a stop by run id reaches it from the
        // first instant; one only scheduled would skip its finalizers on a
        // pre-start interrupt.
        const fiber = yield* Effect.forkChild(
          activation === undefined
            ? operation
            : Effect.withFiber((self) => {
                activation.fiber = self;
                return operation;
              }),
          { startImmediately: true },
        );
        // A stop that reached the launch before its program ran.
        if (activation?.stop) fiber.interruptUnsafe();
        // An interrupted join interrupts the fiber and awaits its cleanup;
        // a generation's launch interrupted so (its caller left) stops it as
        // a release, recorded like every other stop.
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              if (activation !== undefined) this.markStopped(runId, 'released');
              return Fiber.interrupt(fiber);
            }),
          ),
        );
      });
      return withPerKeyLane(this.lanes, runId, refuse)(run);
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

  /** Attach a running loop's controls to its run for the caller's scope
   *  (`LiveRun.controls`); a later loop's attachment is left in place. The
   *  loop runs under its launch's activation; none holds it only once the
   *  session is disposed. */
  attachControls(
    runId: RunId,
    controls: RunControls,
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        const activation = this.activations.get(runId);
        if (activation !== undefined) activation.controls = controls;
      }),
      () =>
        Effect.sync(() => {
          const activation = this.activations.get(runId);
          if (activation?.controls === controls)
            activation.controls = undefined;
        }),
    );
  }

  // ------------------------------------------------------------------ stop

  /** Stop the run's launch here by run id: synchronous, answered at once
   *  from every host surface. The stop is recorded on its activation
   *  ({@link markStopped}) and its fiber, or its resume's while it decides,
   *  interrupted. The answer is read before the interrupt, which can unwind
   *  the run and close its activation. */
  interrupt(runId: RunId, cause: StopCause = 'released'): boolean {
    const activation = this.activations.get(runId);
    if (activation === undefined) return false;
    this.markStopped(runId, cause);
    activation.fiber?.interruptUnsafe();
    return true;
  }

  /**
   * Stop a run (`RunsShape.stop` says what each reason does to its
   * children). A run this process drives is stopped where it stands,
   * children first; a detaching stop only after the children's `run.detach`
   * commits, or a child completing meanwhile would route its result to the
   * stopped parent. A run nothing here owns is given the end the stop owes
   * it ({@link stopEnd}); a refused row fails it.
   */
  stop(runId: RunId, reason: RunStopReason): RunStop {
    const activation = this.activations.get(runId);
    // Marked at the request: from here a child is refused under the run
    // (`assertAdmitsChild`) and a user's message sent while the stop runs
    // waits for the run to drain (`submitFollowUp`); a failed stop unmarks.
    const marked = activation?.stop;
    if (activation !== undefined) this.markStopped(runId, reason);
    let reached = false;
    // The child sweep and the root cascade visit each run once.
    const stopHere = (cascade: boolean): boolean => {
      reached = this.terminate(runId, new Set(), cascade, reason);
      return reached;
    };
    // No end owed (a shutdown, which ends this process's hold and its
    // children's holds with it): the sweep is the whole stop.
    const end = this.stopEnd(runId, reason);
    if (end === undefined) {
      stopHere(true);
      return { accepted: () => reached, settlement: Effect.void };
    }
    // A user's stop: its children follow "Keep agents running".
    const key = GlobalStateKey.DETACH_SUBAGENTS_ON_STOP;
    const apply = Effect.flatMap(
      Effect.suspend(() => Settings.get<boolean>(this.init.roots, key)),
      (detach) =>
        (detach ? this.detachActiveChildren(runId) : Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              // A reached target ends itself; an end owed otherwise is
              // written as an inactive-run step, which a generation admitted
              // meanwhile refuses (`RunLive`) and becomes the target instead.
              stopHere(!detach)
                ? Effect.void
                : this.withInactiveRunStep(runId, end).pipe(
                    Effect.catchIf(isRunLive, () =>
                      Effect.sync(() => stopHere(!detach)),
                    ),
                  ),
            ),
          ),
        ),
    ).pipe(
      // Refused before anything was stopped: the run goes on, unmarked.
      Effect.tapError(() =>
        Effect.sync(() => {
          const current = this.activations.get(runId);
          if (!reached && current !== undefined) current.stop = marked;
        }),
      ),
    );
    return { accepted: () => reached, settlement: apply };
  }

  /** The end a stop owes a run no generation here took it for, decided here
   *  only: a user's stop ends it cancelled, ownerless; a shutdown or a release
   *  owes none. A generation a stop reached ends itself, cancelled. */
  private stopEnd(
    runId: RunId,
    cause: StopCause | undefined,
  ): Effect.Effect<void, Error, SessionServices> | undefined {
    if (cause !== 'user') return undefined;
    const { CANCELLED: outcome } = RUN_OUTCOME;
    const end = { runId, outcome, ownerless: true, reason: cause };
    return Effect.asVoid(this.programs.finalize(end));
  }

  /** The session is closing: refuse every run registered from here on, and
   *  stop every run whose parent this registry does not hold (that parent's
   *  cascade stops the rest). A shutdown owes no end ({@link stopEnd}); a
   *  stopped run keeps its activation until it ended itself ({@link awaitDrained}). */
  stopAll(): void {
    this.closing = true;
    const active = new Set(this.activations.keys());
    for (const runId of active) {
      const parent = this.attachedParent(runId);
      if (parent === null || !active.has(parent)) this.stop(runId, 'shutdown');
    }
  }

  /** Record why `runId` stops, before it is interrupted, on its activation;
   *  only a run this process launched has one. A person's stop outranks
   *  every other cause, and a reason outranks a release. */
  private markStopped(runId: RunId, cause: StopCause): void {
    const activation = this.activations.get(runId);
    if (activation === undefined || activation.stop === 'user') return;
    if (cause !== 'released' || activation.stop === undefined)
      activation.stop = cause;
  }

  /** Stop `runId` here, its children first when `cascadeChildren`: each run
   *  once. A child run is its loop, not only the turn its lifecycle runs, so
   *  its interrupted turn is not delivered to the parent as a completed one. */
  private terminate(
    runId: RunId,
    visited: Set<string>,
    cascadeChildren: boolean,
    reason: RunStopReason,
  ): boolean {
    if (visited.has(runId)) return false;
    visited.add(runId);
    if (cascadeChildren)
      for (const child of this.childRunIds(runId))
        this.terminate(child, visited, true, reason);
    return this.interrupt(runId, reason);
  }

  // ---------------------------------------------------------------- detach

  /**
   * Detach all active subagents from a parent, promoting them to top-level:
   * they keep running and deliver through the follow-up queue. One job
   * decides which children are born and severs those durably, keeping the
   * grants each inherited. The unborn ones have no row to carry it: once
   * the batch commits (a refused one cuts none), before the publisher runs
   * any birth job, their activations are cut, which their birth job reads
   * ({@link bornDetached}): a child is born detached, or detached by rows.
   * The stop marked the parent before reading its children, so none is
   * admitted in between.
   */
  private detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    const { log } = this.init;
    return log
      .transact((tx) =>
        Effect.gen({ self: this }, function* () {
          const children = this.childRunIds(parentRunId);
          // Each born child's kept grants, from its rows and its ancestors'.
          const kept = new Map<RunId, ApprovalGrants>();
          for (const id of children) {
            const facts = yield* log.facts(id);
            if (facts?.start == null || facts.grants === null) continue;
            const parent = facts.start.parent?.id ?? parentRunId;
            const line = yield* ancestryRows((run) => log.facts(run), parent);
            kept.set(
              id,
              grantsKept(grantSource(line), id, parent, facts.grants),
            );
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
          return { children, kept };
        }),
      )
      .pipe(
        // Only a child still here: one gone since has no birth left to cut.
        Effect.map(({ children, kept }) => {
          for (const id of children)
            if (!kept.has(id)) {
              const activation = this.activations.get(id);
              if (activation) activation.unbornParent = null;
            }
        }),
      );
  }

  // ----------------------------------------------------------------- close

  /** Resolve once every owner of `runId` (or of every run) has left: an
   *  activation closes with its launch's fiber, so this awaits that fiber,
   *  and again the one a hand-off put in its place. */
  awaitDrained(runId?: RunId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const launch = (
        runId === undefined
          ? this.activations.values().next().value
          : this.activations.get(runId)
      )?.launch;
      return launch === undefined
        ? Effect.void
        : Effect.andThen(Fiber.await(launch), this.awaitDrained(runId));
    });
  }

  /** Drop every activation at session disposal, releasing a drain waiting
   *  on them, keeping why each was stopping; the session's fork ends their
   *  fibers, and a step admitted but not started is refused as it starts
   *  ({@link admit}). */
  dispose(): void {
    this.disposed = true;
    for (const [runId, { stop }] of this.activations)
      if (stop !== undefined) this.stoppedAtDisposal.set(runId, stop);
    this.activations.clear();
  }
}

/**
 * The session's runs ({@link RunsShape}). Built by the session layer in the
 * session's scope and disposed when that scope closes (`sessionLayer.ts`);
 * its runs, its requests and a host that holds the session take it from
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
 * The services every step of an agent run reads on the way down: what the
 * run requires of the process and the services of the session it is
 * launched on.
 */
export type AgentRunServices = RunServices | SessionServices;
