/**
 * The session's runs: the fibers this process drives, one per run, forked
 * into the session's fiber map, and what a stop does with them.
 *
 * "Does this process run it" is one question, is it live or opening here
 * ({@link RunRegistry.get}), which admission, stop, deletion and follow-up
 * routing all ask, and which the session's view reads as `runsHere`. A run
 * is forked only once its opening committed in the caller's fiber
 * ({@link RunRegistry.start}), so every run here has its rows. A stop
 * commits the run's `run.stop` row, then the stops of every run held here
 * under it (by the stored parent edges, through an ended run between
 * them), then interrupts its fiber, whose end reads the reason from that
 * row; a run no fiber here drives ends in the batch that records the stop,
 * and one still opening is stopped as soon as it is forked.
 */

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Schema,
  type Scope,
} from 'effect';

import type { stopRun } from '@agent/storage/runLifecycle';
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
  type RunId,
  type RunStopReason,
} from '@shared/schemas';
import type { SessionLog, SessionViewAccess } from '@shared/session/runHistory';

import type { LiveRun, RunControls, RunsShape } from './runs';
import type { executeAgent } from './executeAgent';
import type { RunServices } from './ToolServices';
import type { SessionServices } from './rootLaunch';
import { DETACH_SUBAGENTS_ON_STOP_SETTING } from '@shared/state/stateSettings';

/** A launch already has the run here: the one refusal for that fact. Hosts
 *  word it from `message`; a resume reads the tag to report the run
 *  unresumable, not failed. */
export class RunLive extends Schema.TaggedError<RunLive>()('RunLive', {
  runId: Schema.String,
}) {
  override readonly message = `Run is already running: ${this.runId}`;
}

/** Run work refused because the session is disposed or closing. */
class RunAdmissionClosed extends Schema.TaggedError<RunAdmissionClosed>()(
  'RunAdmissionClosed',
  { message: Schema.String },
) {}

/** What the session hands its runs. They read a run's phase and parent
 *  from the session's view and keep no copy of their own. */
export interface RunRegistryInit {
  /** The session's view: each run's parent edge and phase. */
  readonly view: SessionViewAccess['Service'];
  /** The session's log: each run's detach batch. */
  readonly log: SessionLog['Service'];
  /** Tell the session's view which runs are driven here (`runsHere`),
   *  called with the whole set as a fiber is forked or exits. */
  readonly runsHere: (runIds: readonly RunId[]) => void;
  /** The session's roots: the stop policy's setting slots. */
  readonly roots: WorkspaceRoots;
  /** Run `effect` in the caller's fiber on the session's context, never
   *  the caller's: a launch's opening, a stop's rows, a resume's decision.
   *  A tool call's fiber would offer that call's run services. */
  readonly inSession: <A, E>(
    effect: Effect.Effect<A, E, Exclude<AgentRunServices, Runs>>,
  ) => Effect.Effect<A, E>;
  /** Fork a run's program under its id in the session's fiber map, on the
   *  same context. The scope that made the map interrupts every run still
   *  in it when the session closes. */
  readonly fork: <A, E>(
    runId: RunId,
    effect: Effect.Effect<A, E, Exclude<AgentRunServices, Runs>>,
  ) => Fiber.Fiber<A, E>;
  /** The run programs these runs run, given by the session layer: an import
   *  of them here would close a cycle (their tools reach `Runs`). */
  readonly programs: RunPrograms;
  /** No fiber here drives the run any more: wake it, and the parent its
   *  last batch delivered to, for the input each holds (`wakeIfOwed`). */
  readonly wake: (runId: RunId) => void;
}

/** The run programs: a run's program (fresh or resumed), and the rows a
 *  stop commits. */
export interface RunPrograms {
  readonly executeAgent: typeof executeAgent;
  readonly stop: typeof stopRun;
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;

/** A launch's two phases ({@link RunRegistry.start}): what commits in the
 *  caller's fiber, and the program the run's own fiber then runs, both on
 *  the session's context. */
export interface Launch<A, E, B, E2> {
  /** The run's opening: its registration or activation batch, committed
   *  before the run is forked, so a run forked here always has its rows. */
  readonly open: Effect.Effect<A, E, AgentRunServices>;
  /** The run, over what the opening answered. */
  readonly run: (opened: A) => Effect.Effect<B, E2, AgentRunServices>;
}

/** Session-owned registry of runs: one per session, built by the session
 *  layer in that session's scope and provided as {@link Runs}. Its members
 *  past {@link RunsShape} are the harness internals' (`registryOf`). */
export class RunRegistry implements RunsShape {
  /** The fiber driving each run here, from its fork until it exits. */
  private readonly live = new Map<RunId, AnyFiber>();
  /** Each live loop's controls, for its life ({@link attachControls}). */
  private readonly controls = new Map<RunId, RunControls>();
  /** The runs whose opening is committing ({@link start}): a second start
   *  is refused meanwhile, a stop asked meanwhile is kept here for the
   *  start to apply once the opening committed, and `settled` resolves once
   *  the start forked the run or failed. */
  private readonly starting = new Map<
    RunId,
    { stop: RunStopReason | null; readonly settled: Deferred.Deferred<void> }
  >();
  /** The runs whose stop is committing: a start is refused meanwhile. */
  private readonly stopping = new Set<RunId>();
  /** Stops asked of a run id with no rows yet: a launch whose caller minted
   *  the id and has not registered it. Its start takes the stop as one
   *  asked while it opened, so the run ends CANCELLED instead of running.
   *  An entry lives until that start or the session's close. */
  private readonly stoppedBeforeStart = new Map<RunId, RunStopReason>();
  /** The runs a file operation or a deletion holds, for its lifetime
   *  ({@link withInactiveRun}): a launch arriving meanwhile waits for it. */
  private readonly busy = new Map<RunId, Deferred.Deferred<void>>();
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

  /** `effect` on this session's context, its runs included
   *  (`RunRegistryInit.inSession`). */
  inSession<A, E>(
    effect: Effect.Effect<A, E, AgentRunServices>,
  ): Effect.Effect<A, E> {
    return this.init.inSession(effect.pipe(Effect.provideService(Runs, this)));
  }

  /** The runs held here: each one live, or still opening. */
  private heldIds(): readonly RunId[] {
    return [...new Set([...this.live.keys(), ...this.starting.keys()])];
  }

  /** One run this process holds (live, or still opening), or every one. */
  // cast: the overloads RunsShape names, answered by one body.
  readonly get = ((runId?: RunId) =>
    runId === undefined
      ? this.heldIds().flatMap((id) => this.liveRun(id) ?? [])
      : this.liveRun(runId)) as RunsShape['get'];

  private liveRun(runId: RunId): LiveRun | undefined {
    const fiber = this.live.get(runId);
    const opening = this.starting.get(runId);
    if (fiber === undefined && opening === undefined) return undefined;
    const controls = this.controls.get(runId);
    // An opening run drains once its start settled and the fiber it
    // forked, if any, exited.
    const drained =
      fiber !== undefined
        ? Effect.asVoid(Fiber.await(fiber))
        : Effect.flatMap(
            Deferred.await(opening?.settled ?? Deferred.makeUnsafe<void>()),
            () => this.liveRun(runId)?.drained ?? Effect.void,
          );
    return { runId, controls, drained };
  }

  /** The children one parent's detach covers: each run held here whose
   *  edge, as the view holds it, names the parent. */
  private childRunIds(parentRunId: RunId): readonly RunId[] {
    return this.heldIds().filter(
      (id) => this.attachedParent(id) === parentRunId,
    );
  }

  /** The run's attached parent, as the view holds it. */
  attachedParent(runId: RunId): RunId | null {
    return this.init.view.run(runId)?.parentId ?? null;
  }

  /** The run's attached ancestors, nearest first, as the view holds them. */
  private *ancestorsOf(runId: RunId): Generator<RunId> {
    const seen = new Set<RunId>();
    for (
      let id = this.attachedParent(runId);
      id !== null && !seen.has(id);
      id = this.attachedParent(id)
    ) {
      seen.add(id);
      yield id;
    }
  }

  /** The runs held here under `runId`, at any depth, by the stored parent
   *  edges: an ended run between them hides none. What a stop covers, and
   *  what keeps a run's input open and its rows in place. */
  private heldUnder(runId: RunId): readonly RunId[] {
    return this.heldIds().filter((id) =>
      [...this.ancestorsOf(id)].includes(runId),
    );
  }

  /** Whether a run held here is under `runId`: its work goes on. */
  hasLiveDescendants = (runId: RunId): boolean =>
    this.heldUnder(runId).length > 0;

  /**
   * `operation` on `runId` while no launch here drives it or any run under
   * it, and none starts meanwhile (a launch arriving waits for the
   * operation); `RunLive` if one does. A deletion's or a file operation's
   * step on the run, exclusive with its launch for the operation's whole
   * lifetime.
   */
  withInactiveRun<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | RunLive, R> {
    return Effect.suspend(() => {
      if (this.liveRun(runId) !== undefined || this.hasLiveDescendants(runId))
        return Effect.fail(new RunLive({ runId }));
      const held = this.busy.get(runId);
      if (held !== undefined)
        return Effect.andThen(
          Deferred.await(held),
          this.withInactiveRun(runId, operation),
        );
      const done = Deferred.makeUnsafe<void>();
      this.busy.set(runId, done);
      return operation.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.busy.delete(runId);
            Deferred.doneUnsafe(done, Effect.void);
          }),
        ),
      );
    });
  }

  /** The stop asked of `runId` while its opening commits, if one was: an
   *  opening that decides before it commits (a resume) reads it and opens
   *  nothing. */
  stopAsked(runId: RunId): RunStopReason | null {
    return this.starting.get(runId)?.stop ?? null;
  }

  /** The opening of `runId` in flight here, if one is: resolves once it
   *  forked the run or failed. A launch refused because the run was
   *  opening joins it through this (a resume answers the activation that
   *  opening committed). */
  openingOf(runId: RunId): Effect.Effect<void> | undefined {
    const opening = this.starting.get(runId);
    return opening && Deferred.await(opening.settled);
  }

  // -------------------------------------------------------------- launches

  /** Why this registry admits no run work, or `undefined` while it does. */
  private closedRefusal(): RunAdmissionClosed | undefined {
    if (!this.disposed && !this.closing) return undefined;
    const when = this.disposed ? 'after session disposal' : 'while closing';
    const message = `Cannot register run work ${when}.`;
    return new RunAdmissionClosed({ message });
  }

  /** Tell the view the runs held here, as a run enters (before its
   *  opening commits, so the view shows it held by the time its rows
   *  fold) and as it leaves. */
  private publishHeld(): void {
    this.init.runsHere(this.heldIds());
  }

  /**
   * The one launch door: every run starts here. `open` commits the run's
   * opening in the caller's fiber; then `run` is forked under the run's id
   * on the session's context, and the fiber's exit lets the run go. A run
   * already driven here, or one still opening or stopping, refuses the
   * launch with `RunLive`; one a file operation holds waits for it. A stop
   * asked while the opening committed (or the session's close) is applied
   * as the opening answers: a failed opening's run ends on its rows; a
   * committed one is forked and interrupted at once, so its one terminal
   * ends it and releases what the opening acquired. Once the opening
   * answered, the fork is not interruptible: a run with rows always has
   * its fiber or its end.
   */
  start<A, E, B, E2>(
    runId: RunId,
    launch: Launch<A, E, B, E2>,
  ): Effect.Effect<
    { readonly opened: A; readonly fiber: Fiber.Fiber<B, E2> },
    E | Error
  > {
    return Effect.suspend(() => {
      const refused = this.closedRefusal();
      if (refused) return Effect.fail(refused);
      if (
        this.live.has(runId) ||
        this.starting.has(runId) ||
        this.stopping.has(runId)
      )
        return Effect.fail(new RunLive({ runId }));
      const busy = this.busy.get(runId);
      if (busy !== undefined)
        return Effect.andThen(Deferred.await(busy), this.start(runId, launch));
      const opening = {
        stop: this.stoppedBeforeStart.get(runId) ?? null,
        settled: Deferred.makeUnsafe<void>(),
      };
      this.stoppedBeforeStart.delete(runId);
      this.starting.set(runId, opening);
      this.publishHeld();
      // The rows of a stop asked meanwhile: the run's `run.stop` and, with
      // `end`, its end, for a run with rows (an opening that failed before
      // the run was registered has none to stop). One the store refused is
      // said: the run reads as interrupted at its next open.
      const stopRows = (reason: RunStopReason, end: boolean) =>
        this.inSession(this.init.programs.stop(runId, reason, end)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Run ${runId}: the stop asked as it opened was not recorded`,
            ).pipe(Effect.annotateLogs({ data: Cause.squash(cause) })),
          ),
        );
      return Effect.uninterruptibleMask((restore) =>
        restore(this.inSession(launch.open)).pipe(
          // A stop asked meanwhile, or the caller's own interruption (its
          // parent stopped as the child's rows committed): the run the
          // opening registered ends on its rows, so none is left with
          // neither fiber nor end.
          Effect.tapCause((cause) =>
            Effect.suspend(() => {
              const stop =
                opening.stop ??
                (Cause.hasInterrupts(cause)
                  ? this.closedRefusal() === undefined
                    ? 'user'
                    : 'shutdown'
                  : null);
              return stop === null ? Effect.void : stopRows(stop, true);
            }),
          ),
          Effect.flatMap((opened) =>
            Effect.suspend(() => {
              const stop =
                opening.stop ??
                (this.closedRefusal() === undefined ? null : 'shutdown');
              const forked = () => {
                const fiber = this.init.fork(
                  runId,
                  launch.run(opened).pipe(Effect.provideService(Runs, this)),
                );
                this.live.set(runId, fiber);
                fiber.addObserver(() => {
                  if (this.live.get(runId) !== fiber) return;
                  // Its parent's edge, read before the run leaves here.
                  const parent = this.attachedParent(runId);
                  this.live.delete(runId);
                  this.controls.delete(runId);
                  this.publishHeld();
                  this.init.wake(runId);
                  if (parent !== null) this.init.wake(parent);
                });
                // A stop asked meanwhile: the run's stop row is in, and the
                // run is interrupted before its first step, so its one
                // terminal ends it (`endRun`) and releases its resources.
                if (stop !== null) fiber.interruptUnsafe();
                return { opened, fiber };
              };
              return stop === null
                ? Effect.sync(forked)
                : Effect.map(stopRows(stop, false), forked);
            }),
          ),
        ),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.starting.delete(runId);
            if (!this.live.has(runId)) this.publishHeld();
            Deferred.doneUnsafe(opening.settled, Effect.void);
          }),
        ),
      );
    });
  }

  /** Attach a running loop's controls to its run for the caller's scope
   *  (`LiveRun.controls`); a later loop's attachment is left in place. */
  attachControls(
    runId: RunId,
    controls: RunControls,
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.controls.set(runId, controls);
      }),
      () =>
        Effect.sync(() => {
          if (this.controls.get(runId) === controls)
            this.controls.delete(runId);
        }),
    );
  }

  // ------------------------------------------------------------------ stop

  /** Interrupt the fiber driving `runId` here, writing nothing: a caller
   *  that let go of the run it awaited (an in-band call, a handle). The
   *  run ends cancelled through its lifecycle, with no reason. Answers
   *  whether a fiber here took it. */
  interrupt(runId: RunId): boolean {
    const fiber = this.live.get(runId);
    if (fiber === undefined) return false;
    fiber.interruptUnsafe();
    return true;
  }

  /**
   * Stop a run (`RunsShape.stop` says what each reason does to its
   * children). Its `run.stop` row first, so a child registering under it
   * meanwhile is refused (`registrationRows`) and none escapes; then every
   * run held here under it, at any depth (a user's stop detaches its
   * children instead when "Keep agents running" is on); then the
   * interruption of the fiber driving it here. A run no fiber drives here
   * gets its end in the same batch as the stop. A run still opening takes
   * the stop once its opening committed: its start forks it and interrupts
   * it at once. So does a run whose id has no rows yet, when it starts.
   */
  stop(runId: RunId, reason: RunStopReason): Effect.Effect<boolean, Error> {
    return Effect.suspend(() => {
      const opening = this.starting.get(runId);
      if (opening !== undefined) {
        opening.stop ??= reason;
        return Effect.succeed(true);
      }
      const fiber = this.live.get(runId);
      this.stopping.add(runId);
      return Effect.gen({ self: this }, function* () {
        const known = yield* this.inSession(
          this.init.programs.stop(runId, reason, fiber === undefined),
        );
        // No rows and no fiber: the launch has not registered yet. Its start
        // takes the stop (one that began meanwhile already has its opening).
        if (!known && fiber === undefined) {
          const opened = this.starting.get(runId);
          if (opened !== undefined) opened.stop ??= reason;
          else if (!this.stoppedBeforeStart.has(runId))
            this.stoppedBeforeStart.set(runId, reason);
          return false;
        }
        const detach =
          reason === 'user' &&
          (yield* Settings.get(
            this.init.roots,
            DETACH_SUBAGENTS_ON_STOP_SETTING,
          ));
        if (detach) yield* this.detachActiveChildren(runId);
        else
          for (const id of this.heldUnder(runId))
            yield* this.stopHeld(id, reason);
        if (fiber !== undefined) fiber.interruptUnsafe();
        return fiber !== undefined;
      }).pipe(Effect.ensuring(Effect.sync(() => this.stopping.delete(runId))));
    });
  }

  /** The stop of one run under a stopped ancestor, with no cascade of its
   *  own (the ancestor's covers the whole tree): asked of its opening, or
   *  its row and its fiber's interruption; one that left meanwhile needs
   *  none. */
  private stopHeld(
    runId: RunId,
    reason: RunStopReason,
  ): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      const opening = this.starting.get(runId);
      if (opening !== undefined) {
        opening.stop ??= reason;
        return Effect.void;
      }
      const fiber = this.live.get(runId);
      if (fiber === undefined) return Effect.void;
      this.stopping.add(runId);
      return this.inSession(this.init.programs.stop(runId, reason, false)).pipe(
        Effect.andThen(Effect.sync(() => fiber.interruptUnsafe())),
        Effect.ensuring(Effect.sync(() => this.stopping.delete(runId))),
      );
    });
  }

  /** The session is closing: refuse every run started from here on, and
   *  stop every run driven here whose parent is not (that parent's cascade
   *  stops the rest), for the shutdown. A stop whose rows the store
   *  refused, or that the session's view (dead by then) never settled, is
   *  logged; the fiber is interrupted either way. */
  stopAll(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.closing = true;
      // A launch that never started is refused from here on anyway.
      this.stoppedBeforeStart.clear();
      const held = this.heldIds();
      // The held forest's roots: each run's cascade covers what is under it.
      const roots = held.filter(
        (id) => ![...this.ancestorsOf(id)].some((an) => held.includes(an)),
      );
      return Effect.forEach(
        roots,
        (runId) =>
          this.stop(runId, 'shutdown').pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Run ${runId}: its shutdown stop was not recorded`,
              ).pipe(
                Effect.annotateLogs({ data: Cause.squash(cause) }),
                Effect.andThen(Effect.sync(() => this.interrupt(runId))),
              ),
            ),
          ),
        { discard: true },
      );
    });
  }

  /** Resolve once `runId` (or every run held here) is neither live nor
   *  opening here. */
  awaitDrained(runId?: RunId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const held =
        runId === undefined
          ? this.get()
          : [this.get(runId)].flatMap((run) => run ?? []);
      if (held.length === 0) return Effect.void;
      return Effect.forEach(held, (run) => run.drained, {
        discard: true,
      }).pipe(Effect.andThen(this.awaitDrained(runId)));
    });
  }

  // ---------------------------------------------------------------- detach

  /**
   * Detach the children driven here from a parent, promoting them to
   * top-level: they keep running and deliver through the follow-up queue.
   * One job severs each durably, keeping the grants each inherited.
   */
  private detachActiveChildren(parentRunId: RunId): Effect.Effect<void, Error> {
    const { log } = this.init;
    return log.transact((tx) =>
      Effect.gen({ self: this }, function* () {
        // Each child's kept grants, from its rows and its ancestors'.
        const kept = new Map<RunId, ApprovalGrants>();
        for (const id of this.childRunIds(parentRunId)) {
          const facts = yield* log.facts(id);
          if (facts?.start == null || facts.grants === null) continue;
          const parent = facts.start.parent?.id ?? parentRunId;
          const line = yield* ancestryRows((run) => log.facts(run), parent);
          kept.set(id, grantsKept(grantSource(line), id, parent, facts.grants));
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
      }),
    );
  }

  // ----------------------------------------------------------------- close

  /** Drop every run at session disposal: the session's fiber map ends
   *  their fibers with its scope. */
  dispose(): void {
    this.disposed = true;
    this.live.clear();
    this.controls.clear();
    this.publishHeld();
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

/** The registry behind a session's runs, for harness internals only. No
 *  check limits its callers. */
export const registryOf = (runs: RunsShape): RunRegistry =>
  // cast: the session layer builds every session's runs as a RunRegistry.
  runs as RunRegistry;

/**
 * The services every step of an agent run reads on the way down: what the
 * run requires of the process and the services of the session it is
 * launched on.
 */
export type AgentRunServices = RunServices | SessionServices;
