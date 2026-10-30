/**
 * The session's runs: one owner for everything this process holds for a
 * run and everything a stop does with it.
 *
 * The durable owner of a run is its claim (`SessionLog.hold`, `owns`). What
 * this process holds under it is one activation per run: a launch in flight
 * here, from `start`'s call until the fiber it forked exits, setup and end
 * included. The activation exists exactly that long, so "does this process
 * run it" is one question, `get(runId) !== undefined`, which admission, stop,
 * deletion and follow-up routing all ask. Serialization is `withPerKeyLane`:
 * a generation and the steps on an inactive run (its deletion) take the
 * run's lane in call order.
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
  SubscriptionRef,
} from 'effect';

import { finalizeRun } from '@agent/storage/runLifecycle';
import { getRunRecords } from '@agent/storage/runRecords';
import type { RunAttempt } from '@agent/followUp/ToolUseFollowUp';
import type { ProcessServices, SessionOwner } from '@platform/processRuntime';
import { grantsKept, type ApprovalGrants } from '@shared/approvalBypassKind';
import { Settings } from '@shared/config/settings';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import type { RunStopReason } from '@shared/session/runtimeRequest';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import type { rootRun } from './rootLaunch';
import type { SessionHandle } from './SessionHandle';
import type {
  LiveRun,
  RootLaunch,
  RunControls,
  RunsShape,
  RunStop,
  RunStopOptions,
  StopCause,
} from './runs';
import type { executeAgent } from './executeAgent';
import type { decideResume } from './resumeRun';

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
  /** The session these runs belong to, resolved when first used. */
  readonly session: () => SessionHandle;
  /** The fork every run starts on: the session's context, never a caller's, since a fork from a tool call reads that call's run services; a child's parent is data (`parentRunId`), not fiber ancestry. */
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, ProcessServices>,
  ) => Fiber.Fiber<A, E>;
  /** The run programs these runs run, given by the session layer: an import
   *  of them here would close a cycle (their tools reach `Runs`). */
  readonly programs: RunPrograms;
  /** Nothing here holds the run any more: wake it for the input it holds
   *  (`Inbox.wake`). */
  readonly wake: (runId: RunId) => void;
}

/** The run programs: a root launch, a run's program (fresh or resumed),
 *  and a resume's decision. */
export interface RunPrograms {
  readonly root: typeof rootRun;
  readonly executeAgent: typeof executeAgent;
  readonly resume: typeof decideResume;
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

  private liveRun(runId: RunId): LiveRun | undefined {
    const activation = this.activations.get(runId);
    if (activation === undefined) return undefined;
    const { controls } = activation;
    const readsMessages =
      controls !== undefined
        ? !controls.oneShot
        : this.init.session().view.run(runId)?.followUpSupport !==
          USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
    return {
      runId,
      controls,
      parent: this.attachedParent(runId),
      readsMessages,
      stopReason: activation.stop,
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
  private attachedParent(runId: RunId): RunId | null {
    const run = this.init.session().view.run(runId);
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
    const folded = this.init.session().view.run(parentRunId)?.status;
    if (stopping || folded === RUN_PHASE.CANCELLED)
      throw new Error(
        `Cannot launch child run ${childRunId} under run ${parentRunId}: that run was stopped.`,
      );
  }

  /** A root launch (`programs.root`), awaited. */
  launch(spec: RootLaunch): Effect.Effect<CommitOrdinal, Error, SessionOwner> {
    return this.programs.root(spec.request, {
      ...spec.options,
      session: this.init.session(),
    });
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
      admitted: Effect.Effect<A, E | Error, R>,
    ) => Effect.Effect<B, E2, R>,
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
      const fiber = this.init.fork(
        Effect.withFiber((self) => {
          if (refused) return settle(Effect.fail(new RunLive({ runId })));
          const activation = opened(self);
          // The resume decides on this fiber: what a stop interrupts.
          if (attempt !== undefined) activation.fiber = self;
          return settle(body(activation));
        }).pipe(Effect.provideService(Runs, this)),
      );
      if (refused) return fiber;
      const activation = opened(fiber);
      // The last launch's exit closes the activation: a deciding resume
      // whose activation was handed on leaves it to its generation.
      fiber.addObserver(() => {
        if (
          this.activations.get(runId) !== activation ||
          activation.launch !== fiber
        )
          return;
        this.activations.delete(runId);
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
                return this.claimed(runId, operation);
              }),
          { startImmediately: true },
        );
        // A stop that reached the launch before its program ran.
        if (activation?.stop) fiber.interruptUnsafe();
        // An interrupted join interrupts the fiber and awaits its cleanup.
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        );
      });
      return withPerKeyLane(this.lanes, runId, refuse)(run);
    });
  }

  /** A generation's run under its claim, let go before its fiber exits (a
   *  parent woken then reads the child): held from the start if the run
   *  exists (a resume, a process child), so nothing moves it between its
   *  launch's read and its run; a birth's claim is taken at the end to go. */
  private claimed<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R> {
    const session = this.init.session();
    const hold = Effect.flatMap(
      getRunRecords(session, runId).exists(),
      (born) =>
        born
          ? Effect.as(session.log.hold(runId, { ends: true }), true)
          : Effect.succeed(false),
    );
    const letGo = Effect.ignore(hold, {
      log: 'Warn',
      message: `The claim on ${runId} was not let go.`,
    });
    return Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(hold, (held) =>
          restore(operation).pipe(Effect.ensuring(held ? Effect.void : letGo)),
        ),
      ),
    );
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
   * Stop a run, deciding here what happens to its children: the caller's
   * policy, else the session's "Keep subagents running", read as the stop
   * runs. A run this process drives is stopped where it stands, children
   * first; a detaching stop only after the children's `run.detach` commits,
   * or a child completing meanwhile would route its result to the stopped
   * parent. A run nothing here owns is stopped under its claim, taken before
   * its children are touched, and given the end the stop owes it
   * ({@link stopEnd}); a refused claim or row fails it.
   */
  stop(runId: RunId, options: RunStopOptions): RunStop {
    const activation = this.activations.get(runId);
    // Marked at the request: from here a child is refused under the run
    // (`assertAdmitsChild`) and a user's message sent while the stop runs
    // waits for the run to drain (`submitFollowUp`); a failed stop unmarks.
    const marked = activation?.stop;
    if (activation !== undefined) this.markStopped(runId, options.reason);
    const asked = options.detachActiveChildren;
    // Something here to stop: a launch.
    const local = activation !== undefined;
    const end = this.stopEnd(runId, options.reason);
    let reached = false;
    // The child sweep and the root cascade visit each run once.
    const stopHere = (cascade: boolean): boolean => {
      reached = this.terminate(runId, new Set(), cascade, options.reason);
      return reached;
    };
    if (asked === false && (local || end === undefined)) {
      stopHere(true);
      return { accepted: () => reached, settlement: Effect.void };
    }
    const key = GlobalStateKey.DETACH_SUBAGENTS_ON_STOP;
    const apply = Effect.flatMap(
      asked === undefined
        ? Effect.suspend(() =>
            Settings.get<boolean>(this.init.session().roots, key),
          )
        : Effect.succeed(asked),
      (detach) =>
        (detach ? this.detachActiveChildren(runId) : Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              // A reached target ends itself; an end owed otherwise is
              // written as an inactive-run step, which a generation admitted
              // meanwhile refuses (`RunLive`) and becomes the target instead.
              stopHere(!detach) || end === undefined
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
    const held = this.init.session().log.hold(runId, { ends: true });
    return {
      accepted: () => reached,
      settlement: local ? apply : Effect.scoped(Effect.andThen(held, apply)),
    };
  }

  /** The end a stop owes a run no generation here took it for, decided here
   *  only: a user's stop ends it cancelled, ownerless; a shutdown or a release
   *  owes none. A generation a stop reached ends itself, cancelled. */
  private stopEnd(
    runId: RunId,
    cause: StopCause | undefined,
  ): Effect.Effect<void, Error> | undefined {
    if (cause !== 'user') return undefined;
    const { CANCELLED: outcome } = RUN_OUTCOME;
    const end = { runId, outcome, ownerless: true, stopped: true };
    return Effect.asVoid(finalizeRun(this.init.session(), end));
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
      if (parent === null || !active.has(parent))
        this.stop(runId, { detachActiveChildren: false, reason: 'shutdown' });
    }
  }

  /** Record why `runId` stops, before it is interrupted, on its activation;
   *  only a run this process launched has one. */
  private markStopped(runId: RunId, cause: StopCause): void {
    const activation = this.activations.get(runId);
    if (activation && activation.stop !== 'user') activation.stop = cause;
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
                const activation = this.activations.get(id);
                if (activation) activation.unbornParent = null;
              }
          }),
        );
      }).pipe(Effect.scoped),
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
   *  on them; the session's fork ends their fibers, and a step admitted but
   *  not started is refused as it starts ({@link admit}). */
  dispose(): void {
    this.disposed = true;
    this.activations.clear();
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
