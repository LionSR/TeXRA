/**
 * The session's runs: the fibers this process drives, one per run, forked
 * into the session's fiber map, and what a stop does with them.
 *
 * The registry holds one entry per run id it knows (`RunEntry`): the run's
 * state here, which each method reads and changes and nothing else does.
 * "Does this process run it" is one question, is it live or opening here
 * ({@link SessionRunRegistry.get}), which a launch, a stop, a deletion and
 * follow-up routing all ask, and which the session's view reads as
 * `runsHere`. A run is forked only once its opening committed in the
 * caller's fiber ({@link SessionRunRegistry.start}), so every run here has
 * its rows. A stop commits the run's `run.stop` row, then the stops of
 * every run held here under it (by the stored parent edges, through an
 * ended run between them), then interrupts its fiber, whose end reads the
 * reason from that row; a run no fiber here drives ends in the batch that
 * records the stop, and one still opening is stopped as soon as it is
 * forked.
 */

import {
  Cause,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  type Scope,
} from 'effect';

import { stopRun } from '@agent/storage/runLifecycle';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { workspaceEnvironmentLayer } from '@platform/defaults/nodePlatform';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';
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
import type { SessionLog } from '@shared/session/runHistory';

import type { LiveRun, RunControls, RunsShape } from './runs';
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

/** The services the session captured for its run work before its
 *  registry existed: every service a run reads but the registry, which
 *  the registry gives each piece of that work itself. */
type CapturedServices = Exclude<AgentRunServices, Runs | RunRegistry>;

/** What the session hands its runs. They read a run's parent from the
 *  session's log and keep no copy of their own. */
export interface RunRegistryInit {
  /** The session's log: each run's parent edge and its detach batch. */
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
    effect: Effect.Effect<A, E, CapturedServices>,
  ) => Effect.Effect<A, E>;
  /** Fork a run's program under its id in the session's fiber map, on the
   *  same context. The scope that made the map interrupts every run still
   *  in it when the session closes. */
  readonly fork: <A, E>(
    runId: RunId,
    effect: Effect.Effect<A, E, CapturedServices>,
  ) => Fiber.Fiber<A, E>;
  /** No fiber here drives the run any more: wake it, and the parent its
   *  last batch delivered to, for the input each holds (`wakeIfOwed`). */
  readonly wake: (runId: RunId) => void;
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;

/** A launch's opening commits in its caller's fiber
 *  ({@link SessionRunRegistry.start}): a second launch is refused, a stop
 *  asked meanwhile is kept for the launch to apply once the opening
 *  answered, and `settled` resolves once the launch forked the run or
 *  failed. */
interface Opening {
  readonly kind: 'opening';
  stop: RunStopReason | null;
  readonly settled: Deferred.Deferred<void>;
}

/** The fiber driving the run here, from that fiber's first step until it
 *  exits. */
interface Live {
  readonly kind: 'live';
  readonly fiber: AnyFiber;
  /** Its running loop's controls, while one runs
   *  ({@link SessionRunRegistry.attachControls}). */
  controls: RunControls | undefined;
  /** Its stop: committing its rows, or committed with the fiber it
   *  interrupted still ending. A second stop records nothing then, so the
   *  first one's reason stands. */
  stop: 'committing' | 'committed' | null;
}

/** A stop's rows commit for a run no fiber here drives, its end among
 *  them, or for one whose fiber exited as they did: a launch is refused
 *  meanwhile, a second stop records nothing, and a file operation waits
 *  for `done`. */
interface Ending {
  readonly kind: 'ending';
  readonly done: Deferred.Deferred<void>;
}

/** A file operation or a deletion holds the run for its lifetime
 *  ({@link SessionRunRegistry.withInactiveRun}): a launch, a stop or another
 *  operation arriving meanwhile waits for `done`. The stop it found asked
 *  of the id before it had rows (`after`) stands again once it ends. */
interface Busy {
  readonly kind: 'busy';
  readonly done: Deferred.Deferred<void>;
  readonly after: Pending | undefined;
}

/** A stop asked of a run id with no rows yet: a launch whose caller minted
 *  the id and has not registered it. Its launch takes the stop as one asked
 *  while it opened, so the run ends CANCELLED instead of running. Kept until
 *  that launch or the session's close. */
interface Pending {
  readonly kind: 'pending';
  readonly reason: RunStopReason;
}

/** One run id's state here. An id with no entry is a run nothing here
 *  holds. */
type RunEntry = Pending | Opening | Live | Ending | Busy;

/** A launch's two phases ({@link SessionRunRegistry.start}): what commits
 *  in the caller's fiber, and the program the run's own fiber then runs,
 *  both on the session's context. */
export interface Launch<A, E, B, E2> {
  /** The run's opening: its registration or activation batch, committed
   *  before the run is forked, so a run forked here always has its rows. */
  readonly open: Effect.Effect<A, E, AgentRunServices>;
  /** The run, over what the opening answered. */
  readonly run: (opened: A) => Effect.Effect<B, E2, AgentRunServices>;
}

/** Session-owned registry of runs: one per session, built by the session
 *  layer in that session's scope and provided as {@link Runs} and, with
 *  its members past {@link RunsShape}, as {@link RunRegistry}. */
export class SessionRunRegistry implements RunsShape {
  /** Each run id's state here. */
  private readonly entries = new Map<RunId, RunEntry>();
  /** Run work is refused once the session is closing ({@link stopAll}) or
   *  disposed. */
  private session: 'open' | 'closing' | 'disposed' = 'open';

  private readonly init: RunRegistryInit;
  constructor(init: RunRegistryInit) {
    this.init = init;
  }

  // --------------------------------------------------------------- queries

  /** `effect` on this session's context, its runs included
   *  (`RunRegistryInit.inSession`). */
  inSession<A, E>(
    effect: Effect.Effect<A, E, AgentRunServices>,
  ): Effect.Effect<A, E> {
    return this.init.inSession(this.provided(effect));
  }

  /** `effect` with this registry as its session's runs. */
  private provided<A, E>(
    effect: Effect.Effect<A, E, AgentRunServices>,
  ): Effect.Effect<A, E, CapturedServices> {
    return effect.pipe(
      Effect.provideService(Runs, this),
      Effect.provideService(RunRegistry, this),
    );
  }

  /** The runs held here: each one live, or still opening. */
  private heldIds(): readonly RunId[] {
    return [...this.entries].flatMap(([runId, entry]) =>
      entry.kind === 'live' || entry.kind === 'opening' ? [runId] : [],
    );
  }

  /** One run this process holds (live, or still opening), or every one. */
  // cast: the overloads RunsShape names, answered by one body.
  readonly get = ((runId?: RunId) =>
    runId === undefined
      ? this.heldIds().flatMap((id) => this.liveRun(id) ?? [])
      : this.liveRun(runId)) as RunsShape['get'];

  private liveRun(runId: RunId): LiveRun | undefined {
    const entry = this.entries.get(runId);
    if (entry?.kind === 'live')
      return {
        runId,
        controls: entry.controls,
        drained: Effect.asVoid(Fiber.await(entry.fiber)),
      };
    if (entry?.kind !== 'opening') return undefined;
    // It drains once its launch answered and the fiber that launch forked,
    // if any, exited.
    const drained = Effect.flatMap(
      Deferred.await(entry.settled),
      () => this.liveRun(runId)?.drained ?? Effect.void,
    );
    return { runId, controls: undefined, drained };
  }

  /** The children one parent's detach covers: each run held here whose
   *  edge names the parent. */
  private childRunIds(parentRunId: RunId): Effect.Effect<readonly RunId[]> {
    return this.heldWhere((id) =>
      Effect.map(this.attachedParent(id), (parent) => parent === parentRunId),
    );
  }

  /** The runs held here that `matches`, read from the store. The reads
   *  yield, so a launch can arrive during them: the answer is read again
   *  until it is of the runs held as it is given. */
  private heldWhere(
    matches: (runId: RunId) => Effect.Effect<boolean>,
  ): Effect.Effect<readonly RunId[]> {
    return Effect.suspend(() => {
      const held = this.heldIds();
      return Effect.flatMap(Effect.filter(held, matches), (matching) =>
        this.heldSince(held)
          ? Effect.succeed(matching)
          : this.heldWhere(matches),
      );
    });
  }

  /** Whether the runs held here are still exactly `held`. */
  private heldSince(held: readonly RunId[]): boolean {
    const now = this.heldIds();
    return now.length === held.length && now.every((id) => held.includes(id));
  }

  /** The run's attached parent, as the store holds it at this call (the
   *  view trails the log, and would not know a child launched a moment
   *  ago, which a stop must still reach). A store that cannot be read is a
   *  defect: no cascade can be decided without it. */
  attachedParent(runId: RunId): Effect.Effect<RunId | null> {
    return this.init.log.facts(runId).pipe(
      Effect.orDie,
      Effect.map((facts) => facts?.parent?.id ?? null),
    );
  }

  /** The run's attached ancestors, nearest first. */
  private ancestorsOf = Effect.fnUntraced(
    { self: this },
    function* (runId: RunId) {
      const line: RunId[] = [];
      for (
        let id = yield* this.attachedParent(runId);
        id !== null && !line.includes(id);
        id = yield* this.attachedParent(id)
      )
        line.push(id);
      return line;
    },
  );

  /** The runs held here under `runId`, at any depth, by the stored parent
   *  edges: an ended run between them hides none. What a stop covers, and
   *  what keeps a run's input open and its rows in place. */
  private heldUnder(runId: RunId): Effect.Effect<readonly RunId[]> {
    return this.heldWhere((id) =>
      Effect.map(this.ancestorsOf(id), (line) => line.includes(runId)),
    );
  }

  /** Whether a run held here is under `runId`: its work goes on. */
  hasLiveDescendants = (runId: RunId): Effect.Effect<boolean> =>
    Effect.map(this.heldUnder(runId), (held) => held.length > 0);

  /**
   * `operation` on `runId` while no launch here drives it or any run under
   * it, and none starts meanwhile (a launch arriving waits for the
   * operation); `RunLive` if one does. A deletion's or a file operation's
   * step on the run, exclusive with its launch for the operation's whole
   * lifetime. One arriving while a stop's rows commit for the run waits
   * for them.
   */
  withInactiveRun<A, E, R>(
    runId: RunId,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | RunLive, R> {
    return Effect.suspend(() => {
      const held = this.heldIds();
      return Effect.flatMap(this.hasLiveDescendants(runId), (descendants) =>
        // From here to the exclusion nothing yields: a launch that arrived
        // while the edges were read is checked again first.
        this.heldSince(held)
          ? this.excluding(runId, descendants, operation)
          : this.withInactiveRun(runId, operation),
      );
    });
  }

  /** {@link withInactiveRun}'s step once its descendants are read: it
   *  checks and takes the exclusion as it is called, so nothing yields
   *  between the two. */
  private excluding<A, E, R>(
    runId: RunId,
    descendants: boolean,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | RunLive, R> {
    if (descendants) return Effect.fail(new RunLive({ runId }));
    const entry = this.entries.get(runId);
    switch (entry?.kind) {
      case 'opening':
      case 'live':
        return Effect.fail(new RunLive({ runId }));
      case 'ending':
      case 'busy':
        return Effect.andThen(
          Deferred.await(entry.done),
          this.withInactiveRun(runId, operation),
        );
    }
    const busy: Busy = {
      kind: 'busy',
      done: Deferred.makeUnsafe<void>(),
      after: entry,
    };
    this.entries.set(runId, busy);
    return operation.pipe(
      Effect.ensuring(Effect.sync(() => this.pass(runId, busy, busy.after))),
    );
  }

  /** The stop asked of `runId` while its opening commits, if one was: an
   *  opening that decides before it commits (a resume) reads it and opens
   *  nothing. */
  stopAsked(runId: RunId): RunStopReason | null {
    const entry = this.entries.get(runId);
    return entry?.kind === 'opening' ? entry.stop : null;
  }

  /** The opening of `runId` in flight here, if one is: resolves once it
   *  forked the run or failed. A launch refused because the run was
   *  opening joins it through this (a resume answers the activation that
   *  opening committed). */
  openingOf(runId: RunId): Effect.Effect<void> | undefined {
    const entry = this.entries.get(runId);
    return entry?.kind === 'opening'
      ? Deferred.await(entry.settled)
      : undefined;
  }

  // -------------------------------------------------------------- launches

  /** Why this registry takes no run work, or `undefined` while it does. */
  private closedRefusal(): RunAdmissionClosed | undefined {
    if (this.session === 'open') return undefined;
    const when =
      this.session === 'disposed' ? 'after session disposal' : 'while closing';
    const message = `Cannot register run work ${when}.`;
    return new RunAdmissionClosed({ message });
  }

  /** Tell the view the runs held here, as a run enters (before its
   *  opening commits, so the view shows it held by the time its rows
   *  apply) and as it leaves. */
  private publishHeld(): void {
    this.init.runsHere(this.heldIds());
  }

  /** `entry`, a state `runId` passes through, gives way to `next` (none:
   *  nothing is held of the run here any more), and what waited for it
   *  goes on. */
  private pass(runId: RunId, entry: Ending | Busy, next?: RunEntry): void {
    if (this.entries.get(runId) === entry) {
      if (next === undefined) this.entries.delete(runId);
      else this.entries.set(runId, next);
    }
    Deferred.doneUnsafe(entry.done, Effect.void);
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
      const entry = this.entries.get(runId);
      switch (entry?.kind) {
        case 'opening':
        case 'live':
        case 'ending':
          return Effect.fail(new RunLive({ runId }));
        case 'busy':
          return Effect.andThen(
            Deferred.await(entry.done),
            this.start(runId, launch),
          );
      }
      // Held nowhere here: it opens, and a stop asked before it had rows is
      // one asked as it opened.
      const opening: Opening = {
        kind: 'opening',
        stop: entry?.reason ?? null,
        settled: Deferred.makeUnsafe<void>(),
      };
      this.entries.set(runId, opening);
      this.publishHeld();
      // The rows of a stop asked meanwhile: the run's `run.stop` and, with
      // `end`, its end, for a run with rows (an opening that failed before
      // the run was registered has none to stop). One the store refused is
      // said: the run reads as interrupted at its next open.
      const stopRows = (reason: RunStopReason, end: boolean) =>
        this.inSession(stopRun(runId, reason, end)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Run ${runId}: the stop asked as it opened was not recorded`,
            ).pipe(Effect.annotateLogs({ data: cause })),
          ),
        );
      // Resolve the launch's environment before its opening acquires
      // resources, then carry only those values into the run's fiber.
      // Management stays on the session's stable services.
      const open = Effect.gen(function* () {
        const environment = Context.pick(
          ConfigProvider.ConfigProvider,
          ProjectEnvironment,
        )(yield* Effect.context());
        const opened = yield* launch.open;
        return { opened, environment };
      }).pipe(
        Effect.provide(workspaceEnvironmentLayer(this.init.roots.workspace)),
      );
      return Effect.uninterruptibleMask((restore) =>
        restore(this.inSession(open)).pipe(
          // A stop asked meanwhile, or the caller's own interruption (its
          // parent stopped as the child's rows committed): the run the
          // opening registered ends on its rows, so none is left with
          // neither fiber nor end.
          Effect.tapCause((cause) =>
            Effect.suspend(() => {
              const stop =
                opening.stop ??
                (Cause.hasInterrupts(cause)
                  ? this.session === 'open'
                    ? 'user'
                    : 'shutdown'
                  : null);
              return stop === null ? Effect.void : stopRows(stop, true);
            }),
          ),
          Effect.flatMap(({ opened, environment }) =>
            Effect.suspend(() => {
              const stop =
                opening.stop ?? (this.session === 'open' ? null : 'shutdown');
              // The fiber takes the run as its first step, before its
              // program runs, so the program finds its run live here; its
              // exit lets the run go.
              const program = Effect.withFiber((fiber) => {
                const live: Live = {
                  kind: 'live',
                  fiber,
                  controls: undefined,
                  stop: null,
                };
                this.entries.set(runId, live);
                fiber.addObserver(() => {
                  if (this.entries.get(runId) !== live) return;
                  // A stop still committing holds a launch off until its
                  // rows are in.
                  if (live.stop === 'committing')
                    this.entries.set(runId, {
                      kind: 'ending',
                      done: Deferred.makeUnsafe<void>(),
                    });
                  else this.entries.delete(runId);
                  this.publishHeld();
                  this.init.wake(runId);
                });
                return launch.run(opened);
              });
              const forked = () => {
                const fiber = this.init.fork(
                  runId,
                  this.provided(program.pipe(Effect.provide(environment))),
                );
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
            // Not forked: the run leaves here.
            if (this.entries.get(runId) === opening) {
              this.entries.delete(runId);
              this.publishHeld();
            }
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
        const entry = this.entries.get(runId);
        if (entry?.kind === 'live') entry.controls = controls;
        return entry;
      }),
      (entry) =>
        Effect.sync(() => {
          if (entry?.kind === 'live' && entry.controls === controls)
            entry.controls = undefined;
        }),
    ).pipe(Effect.asVoid);
  }

  // ------------------------------------------------------------------ stop

  /** Interrupt the fiber driving `runId` here, writing nothing: a caller
   *  that let go of the run it awaited (an in-band call, a handle). The
   *  run ends cancelled through its lifecycle, with no reason. Answers
   *  whether a fiber here took it. */
  interrupt(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (entry?.kind !== 'live') return false;
    entry.fiber.interruptUnsafe();
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
   * it at once. So does a run whose id has no rows yet, when it starts. A
   * run a file operation holds is stopped once the operation ends.
   */
  stop(runId: RunId, reason: RunStopReason): Effect.Effect<boolean, Error> {
    return Effect.suspend(() => {
      const entry = this.entries.get(runId);
      switch (entry?.kind) {
        case 'opening':
          entry.stop ??= reason;
          return Effect.succeed(true);
        case 'live':
          if (entry.stop !== null) return Effect.succeed(true);
          entry.stop = 'committing';
          return this.stopLive(
            runId,
            entry,
            reason,
            this.stopUnder(runId, reason),
          );
        case 'ending':
        case 'pending':
          return Effect.succeed(false);
        case 'busy':
          return Effect.andThen(
            Deferred.await(entry.done),
            this.stop(runId, reason),
          );
      }
      // No fiber here drives it: its end commits with its stop, and a
      // launch is refused until it has.
      const ending: Ending = {
        kind: 'ending',
        done: Deferred.makeUnsafe<void>(),
      };
      this.entries.set(runId, ending);
      return this.inSession(stopRun(runId, reason, true)).pipe(
        Effect.tap((known) =>
          known ? this.stopUnder(runId, reason) : Effect.void,
        ),
        // No rows: the launch has not registered yet, and takes the stop
        // when it starts.
        Effect.onExit((exit) =>
          Effect.sync(() =>
            this.pass(
              runId,
              ending,
              Exit.isSuccess(exit) && !exit.value
                ? { kind: 'pending', reason }
                : undefined,
            ),
          ),
        ),
        Effect.as(false),
      );
    });
  }

  /** What a stop of `runId` does to the runs held here under it: a user's
   *  stop detaches its children while "Keep agents running" is on; any
   *  other stop ends every run under it, at any depth. */
  private stopUnder(
    runId: RunId,
    reason: RunStopReason,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const detach =
        reason === 'user' &&
        (yield* Settings.get(
          this.init.roots,
          DETACH_SUBAGENTS_ON_STOP_SETTING,
        ));
      if (detach) yield* this.detachActiveChildren(runId);
      else
        for (const id of yield* this.heldUnder(runId))
          yield* this.stopHeld(id, reason);
    });
  }

  /** The stop of a run whose fiber is `live` here, its stop marked
   *  committing: its `run.stop` row, then `under` (what the stop does to
   *  the runs under it), then its fiber's interruption. Answers that a
   *  fiber here took the stop. */
  private stopLive(
    runId: RunId,
    live: Live,
    reason: RunStopReason,
    under: Effect.Effect<void, Error>,
  ): Effect.Effect<boolean, Error> {
    return this.inSession(stopRun(runId, reason, false)).pipe(
      Effect.andThen(under),
      Effect.andThen(Effect.sync(() => live.fiber.interruptUnsafe())),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const entry = this.entries.get(runId);
          // Committed, it holds until the fiber it interrupted ends; one
          // that failed can be asked again.
          if (entry === live)
            live.stop = Exit.isSuccess(exit) ? 'committed' : null;
          // The fiber exited as the rows committed: what waited for them
          // goes on.
          else if (entry?.kind === 'ending') this.pass(runId, entry);
        }),
      ),
      Effect.as(true),
    );
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
      const entry = this.entries.get(runId);
      switch (entry?.kind) {
        case 'opening':
          entry.stop ??= reason;
          return Effect.void;
        case 'live':
          if (entry.stop !== null) return Effect.void;
          entry.stop = 'committing';
          return Effect.asVoid(
            this.stopLive(runId, entry, reason, Effect.void),
          );
        default:
          return Effect.void;
      }
    });
  }

  /** The session is closing: refuse every run started from here on, and
   *  stop every run driven here whose parent is not (that parent's cascade
   *  stops the rest), for the shutdown. A stop whose rows the store
   *  refused, or that the session's view (dead by then) never applied, is
   *  logged; the fiber is interrupted either way. */
  stopAll(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.session === 'open') this.session = 'closing';
      // A launch that never started is refused from here on anyway.
      for (const [runId, entry] of this.entries)
        if (entry.kind === 'pending') this.entries.delete(runId);
      const held = this.heldIds();
      // The held forest's roots: each run's cascade covers what is under it.
      const roots = Effect.filter(held, (id) =>
        Effect.map(
          this.ancestorsOf(id),
          (line) => !line.some((an) => held.includes(an)),
        ),
      ).pipe(
        // A store that cannot say which run is under which: each held run
        // is stopped by name.
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "The held runs' parents could not be read at shutdown; stopping each",
          ).pipe(Effect.annotateLogs({ data: cause }), Effect.as(held)),
        ),
      );
      return Effect.flatMap(roots, (roots) =>
        Effect.forEach(
          roots,
          (runId) =>
            this.stop(runId, 'shutdown').pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `Run ${runId}: its shutdown stop was not recorded`,
                ).pipe(
                  Effect.annotateLogs({ data: cause }),
                  Effect.andThen(Effect.sync(() => this.interrupt(runId))),
                ),
              ),
            ),
          { discard: true },
        ),
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
        for (const id of yield* this.childRunIds(parentRunId)) {
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
   *  their fibers with its scope, and a fiber exiting then wakes nothing. */
  dispose(): void {
    this.session = 'disposed';
    for (const [runId, entry] of this.entries)
      if (entry.kind === 'live') this.entries.delete(runId);
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

/**
 * The registry behind a session's {@link Runs}, whole: the launch door,
 * the stops and the steps on an inactive run, a loop's controls. Harness
 * internals take it from context, served by the session layer beside
 * `Runs` on the same registry; a host holds `Runs`.
 */
export class RunRegistry extends Context.Service<
  RunRegistry,
  SessionRunRegistry
>()('@texra-ai/harness/session/RunRegistry') {}

/**
 * The services every step of an agent run reads on the way down: what the
 * run requires of the process and the services of the session it is
 * launched on.
 */
export type AgentRunServices = RunServices | SessionServices;
