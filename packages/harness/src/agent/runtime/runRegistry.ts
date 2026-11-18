/**
 * The session's runs: the fibers this process drives, one per run, forked
 * into the session's fiber map, and what a stop does with them.
 *
 * The registry holds one entry per run id it knows (`RunEntry`): the run's
 * state here, which each method reads and changes and nothing else does.
 * "Does this process run it" is one question, is it live or opening here
 * ({@link SessionRunRegistry.get}), which a launch, a stop, a deletion and
 * follow-up routing all ask, and which the session's view reads as
 * `runsHere`. A run is its fiber from the launch's first step
 * ({@link SessionRunRegistry.start}): the fiber opens the run (acquiring
 * its resources in a scope of its own and committing its first rows), then
 * runs it, then ends it, and its launcher only awaits what the opening
 * answers. A stop commits the run's `run.stop` row when it has rows, then
 * the stops of every run held here under it (by the stored parent edges,
 * through an ended run between them), then interrupts its fiber, whose end
 * reads the reason from that row; a run whose opening the stop cut ends on
 * the rows that opening committed, and a run no fiber here drives ends in
 * the batch that records the stop.
 */

import {
  Cause,
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
import { workspaceEnvironmentLayer } from '@platform/defaults/nodeServices';
import type { RunId, RunStopReason } from '@shared/schemas';
import type { SessionLog } from '@shared/session/runHistory';
import { ancestorIds } from '@shared/session/runRelation';
import { ensureError } from '@utils/errors/errorMessage';

import type { LiveRun, RunControls, RunsShape } from './runs';
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

/**
 * The provider API-key variables a launch brought, by variable name
 * (`StartInput.apiKeys`), provided where the session starts or resumes
 * the run. The registry carries the launcher's onto the run's fiber, so a
 * child it starts or resumes from its tool calls, and a leftover child it
 * resumes, opens with them; a sweep with no launch behind it has none.
 */
export const LaunchKeys = Context.Reference<Readonly<Record<string, string>>>(
  '@texra-ai/harness/LaunchKeys',
  { defaultValue: () => ({}) },
);

/** A stop reached the run before its opening answered: the launch is
 *  refused. A run whose first rows had committed also ends CANCELLED on
 *  them, with the stop's row. */
export class RunStopped extends Schema.TaggedError<RunStopped>()('RunStopped', {
  runId: Schema.String,
}) {
  override readonly message = `Run ${this.runId} was stopped before it started.`;
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
  /** The session's log: each run's parent edge. */
  readonly log: SessionLog['Service'];
  /** Tell the session's view which runs are driven here (`runsHere`),
   *  called with the whole set as a fiber is forked or exits. */
  readonly runsHere: (runIds: readonly RunId[]) => void;
  /** The session's roots: the workspace a launch's environment reads. */
  readonly roots: WorkspaceRoots;
  /** Run `effect` in the caller's fiber on the session's context, never
   *  the caller's: a stop's rows, a resume's join. A tool call's fiber
   *  would offer that call's run services. */
  readonly inSession: <A, E>(
    effect: Effect.Effect<A, E, CapturedServices>,
  ) => Effect.Effect<A, E>;
  /** Fork a run's program, its opening included, under its id in the
   *  session's fiber map, on the same context. The scope that made the map
   *  interrupts every run still in it when the session closes. */
  readonly fork: <A, E>(
    runId: RunId,
    effect: Effect.Effect<A, E, CapturedServices>,
  ) => Fiber.Fiber<A, E>;
  /** No fiber here drives the run any more: wake it, and the parent its
   *  last batch delivered to, for the input each holds (`wakeIfOwed`). */
  readonly wake: (runId: RunId) => void;
}

type AnyFiber = Fiber.Fiber<unknown, unknown>;

/** The fiber driving the run here, from the launch's first step (its
 *  opening included) until it exits. */
interface Live {
  readonly kind: 'live';
  readonly fiber: AnyFiber;
  /** Resolves once the run's opening answered its launcher, whichever way:
   *  a resume of a run still opening joins it through this. */
  readonly opened: Effect.Effect<void>;
  /** Its running loop's controls, while one runs
   *  ({@link SessionRunRegistry.attachControls}). */
  controls: RunControls | undefined;
  /** Its stop: the reason asked, read again if the stop cut the run's
   *  opening, and whether its rows are in. With rows still committing, the
   *  fiber exiting holds a launch off until they are; a second stop
   *  records nothing, so the first one's reason stands. */
  stop: { readonly reason: RunStopReason; committed: boolean } | null;
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

/** A stop asked of a run id with nothing here and no rows yet: a launch
 *  whose caller minted the id and has not reached the registry. Its launch
 *  is refused when it does (`RunStopped`), so the stop is not lost. Kept
 *  until that launch or the session's close. */
interface Pending {
  readonly kind: 'pending';
  readonly reason: RunStopReason;
}

/** One run id's state here. An id with no entry is a run nothing here
 *  holds. */
type RunEntry = Pending | Live | Ending | Busy;

/** What a stop found and marked on its run ({@link SessionRunRegistry.stop}):
 *  nothing to do, ask again once an operation ends, or the run in the state
 *  the stop then acts on. */
type StopClaim =
  | { readonly kind: 'done'; readonly took: boolean }
  | { readonly kind: 'again'; readonly after: Effect.Effect<void> }
  | { readonly kind: 'live'; readonly live: Live }
  | { readonly kind: 'ending'; readonly ending: Ending };

/** How a stop went: whether a fiber here took it, and whether the run had
 *  no rows to record it on. */
interface StopResult {
  readonly took: boolean;
  readonly unknown: boolean;
}

/** A run as its own fiber runs it ({@link SessionRunRegistry.start}): the
 *  opening, whose answer its launcher awaits; the run over what it opened;
 *  and the end every exit of the run reaches. All three on the session's
 *  context, the opening and the run interruptible, the end not. */
export interface Launch<A, E, B, C> {
  /** The run's opening: its resources, acquired into the fiber's scope,
   *  and its registration or activation batch. A failure here is the
   *  launch's: nothing of the run is left but what the batch committed. */
  readonly open: Effect.Effect<A, E, AgentRunServices | Scope.Scope>;
  /** The run, over what the opening answered. */
  readonly run: (opened: A) => Effect.Effect<B, E, AgentRunServices>;
  /** The run's one terminal, from every exit of `run`. */
  readonly end: (
    opened: A,
    exit: Exit.Exit<B, E>,
  ) => Effect.Effect<C, E, AgentRunServices>;
}

/** Why a launch is refused before or as its run opens. */
type LaunchRefusal = RunLive | RunAdmissionClosed | RunStopped;

/** Session-owned registry of runs: one per session, built by the session
 *  layer in that session's scope and provided as {@link Runs} and, with
 *  its members past {@link RunsShape}, as {@link RunRegistry}. */
export class SessionRunRegistry implements RunsShape {
  /** Each run id's state here. */
  private readonly entries = new Map<RunId, RunEntry>();
  /** Run work is refused once the session is closing
   *  ({@link interruptAll}) or disposed. */
  private session: 'open' | 'closing' | 'disposed' = 'open';

  /** Whether the session is closing or closed: a run its close interrupts
   *  is left as its rows stand, with no stop and no end. */
  get closing(): boolean {
    return this.session !== 'open';
  }

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

  /** The runs held here: each one's fiber, opening or running. */
  private heldIds(): readonly RunId[] {
    return [...this.entries].flatMap(([runId, entry]) =>
      entry.kind === 'live' ? [runId] : [],
    );
  }

  /** One run this process holds (opening or running), or every one. */
  // cast: the overloads RunsShape names, answered by one body.
  readonly get = ((runId?: RunId) =>
    runId === undefined
      ? this.heldIds().flatMap((id) => this.liveRun(id) ?? [])
      : this.liveRun(runId)) as RunsShape['get'];

  private liveRun(runId: RunId): LiveRun | undefined {
    const entry = this.entries.get(runId);
    if (entry?.kind !== 'live') return undefined;
    return {
      runId,
      controls: entry.controls,
      drained: Effect.map(Fiber.await(entry.fiber), (exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? ensureError(exit.cause)
          : undefined,
      ),
    };
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
      Effect.map((facts) => facts?.start?.parent?.id ?? null),
    );
  }

  /** The runs held here under `runId`, at any depth, by the stored parent
   *  edges: an ended run between them hides none. What a stop covers, and
   *  what keeps a run's input open and its rows in place. */
  private heldUnder(runId: RunId): Effect.Effect<readonly RunId[]> {
    return this.heldWhere((id) =>
      Effect.map(
        ancestorIds((up) => this.attachedParent(up), id),
        (line) => line.includes(runId),
      ),
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
        // The check and the hold are one step, released on every exit: a
        // launch that arrived while the edges were read is seen in it.
        Effect.acquireUseRelease(
          Effect.sync(() => this.holdInactive(runId, held, descendants)),
          (hold): Effect.Effect<A, E | RunLive, R> => {
            switch (hold.kind) {
              case 'held':
                return operation;
              case 'live':
                return Effect.fail(new RunLive({ runId }));
              case 'again':
                return Effect.andThen(
                  hold.after,
                  this.withInactiveRun(runId, operation),
                );
            }
          },
          (hold) =>
            hold.kind === 'held'
              ? Effect.sync(() => this.pass(runId, hold.busy, hold.busy.after))
              : Effect.void,
        ),
      );
    });
  }

  /** {@link withInactiveRun}'s hold, decided and taken in one step once
   *  the run's descendants are read: the run is held, a launch drives it or
   *  a run under it, or the question is asked again (the held runs changed
   *  during the read, or another operation or a stop has the run). */
  private holdInactive(
    runId: RunId,
    held: readonly RunId[],
    descendants: boolean,
  ):
    | { readonly kind: 'held'; readonly busy: Busy }
    | { readonly kind: 'live' }
    | { readonly kind: 'again'; readonly after: Effect.Effect<void> } {
    if (!this.heldSince(held)) return { kind: 'again', after: Effect.void };
    if (descendants) return { kind: 'live' };
    const entry = this.entries.get(runId);
    switch (entry?.kind) {
      case 'live':
        return { kind: 'live' };
      case 'ending':
      case 'busy':
        return { kind: 'again', after: Deferred.await(entry.done) };
    }
    const busy: Busy = {
      kind: 'busy',
      done: Deferred.makeUnsafe<void>(),
      after: entry,
    };
    this.entries.set(runId, busy);
    return { kind: 'held', busy };
  }

  /** Resolves once the opening of the run driven here answered its
   *  launcher, whichever way; `undefined` for a run no fiber here drives. A
   *  launch refused because the run is here joins it through this (a
   *  resume answers the activation that opening committed). */
  opened(runId: RunId): Effect.Effect<void> | undefined {
    const entry = this.entries.get(runId);
    return entry?.kind === 'live' ? entry.opened : undefined;
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
   * The one launch door: every run starts here, as a fiber of its own
   * forked under the run's id on the session's context, in the one step
   * that checks it may: a run already driven here, or one whose stop's
   * rows are still committing, refuses the launch with `RunLive`; a stop
   * asked of the id before any launch reached it, with `RunStopped`; a
   * file operation holding the run makes the launch wait for it. The fiber
   * opens the run in a scope it owns, runs it and ends it ({@link Launch}),
   * with the launcher's `LaunchKeys` and the workspace's environment, read
   * once as it opens; the launch answers what the opening answered, or why
   * it failed. A stop that cuts the opening refuses the launch
   * (`RunStopped`), and the run ends on the rows the opening had committed,
   * if any.
   */
  start<A, E, B, C>(
    runId: RunId,
    launch: Launch<A, E, B, C>,
  ): Effect.Effect<
    { readonly opened: A; readonly fiber: Fiber.Fiber<C, E> },
    E | LaunchRefusal
  > {
    return Effect.flatMap(Effect.service(LaunchKeys), (keys) =>
      Effect.suspend(() => {
        const entered = this.enter(runId, launch, keys);
        switch (entered.kind) {
          case 'refused':
            return Effect.fail(entered.error);
          case 'again':
            return Effect.andThen(entered.after, this.start(runId, launch));
          case 'live':
            return Deferred.await(entered.answer).pipe(
              // The launcher let go while the run opened: a `user` stop of
              // it, which reaches no run under it. A closing session's
              // interruption writes nothing.
              Effect.onInterrupt(() =>
                this.closing || Deferred.isDoneUnsafe(entered.answer)
                  ? Effect.void
                  : this.stopping(runId, 'user', false).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          `Run ${runId}: the stop of its abandoned launch was not recorded`,
                        ).pipe(Effect.annotateLogs({ data: cause })),
                      ),
                    ),
              ),
              // The answer wakes the launcher inside the run's own step;
              // the launcher yields once so the run goes on to its first
              // wait, its loop's controls attached, before the launch
              // returns: a host asking them at once finds them.
              Effect.tap(() => Effect.uninterruptible(Effect.yieldNow)),
              Effect.map((opened) => ({ opened, fiber: entered.fiber })),
            );
        }
      }),
    );
  }

  /** A launch's one step: the launch is refused, asks again once the
   *  operation holding the run ends, or its run is forked and held here. */
  private enter<A, E, B, C>(
    runId: RunId,
    launch: Launch<A, E, B, C>,
    keys: Readonly<Record<string, string>>,
  ):
    | {
        readonly kind: 'live';
        readonly fiber: Fiber.Fiber<C, E>;
        readonly answer: Deferred.Deferred<A, E | LaunchRefusal>;
      }
    | { readonly kind: 'refused'; readonly error: LaunchRefusal }
    | { readonly kind: 'again'; readonly after: Effect.Effect<void> } {
    const refused = this.closedRefusal();
    if (refused) return { kind: 'refused', error: refused };
    const entry = this.entries.get(runId);
    switch (entry?.kind) {
      case 'live':
      case 'ending':
        return { kind: 'refused', error: new RunLive({ runId }) };
      case 'busy':
        return { kind: 'again', after: Deferred.await(entry.done) };
      case 'pending':
        // The stop its caller asked before it got here: it never runs.
        this.entries.delete(runId);
        return { kind: 'refused', error: new RunStopped({ runId }) };
    }
    const answer = Deferred.makeUnsafe<A, E | LaunchRefusal>();
    // The fiber takes the run here as its first step, which the fork runs
    // before it returns: no other launch, stop or read finds the id free
    // in between, and the program finds its run held.
    let held: Live | undefined;
    const program = Effect.withFiber((fiber) => {
      held = this.hold(runId, fiber, answer);
      return this.program(runId, launch, answer);
    });
    const fiber = this.init.fork(
      runId,
      this.provided(program).pipe(Effect.provideService(LaunchKeys, keys)),
    );
    // A fork that only schedules its fiber would leave the id free until
    // that step runs; this registry is wrong on such a runtime, so it says
    // so rather than admit a second launch.
    if (held === undefined) {
      fiber.interruptUnsafe();
      throw new Error(`Run ${runId}: its fiber did not start as it forked`);
    }
    const live = held;
    // Called at once if the fiber already exited.
    fiber.addObserver((exit) => this.leave(runId, live, answer, exit));
    return { kind: 'live', fiber, answer };
  }

  /** The run's fiber holds it here, from its first step until it exits
   *  ({@link leave}). */
  private hold<A, E>(
    runId: RunId,
    fiber: AnyFiber,
    answer: Deferred.Deferred<A, E | LaunchRefusal>,
  ): Live {
    const live: Live = {
      kind: 'live',
      fiber,
      opened: Effect.asVoid(Effect.exit(Deferred.await(answer))),
      controls: undefined,
      stop: null,
    };
    this.entries.set(runId, live);
    this.publishHeld();
    return live;
  }

  /** The run's fiber exited: the run leaves here, a run that opened is
   *  woken for the input it may be owed, and a launch whose run did not
   *  open is told why. */
  private leave<A, C, E>(
    runId: RunId,
    live: Live,
    answer: Deferred.Deferred<A, E | LaunchRefusal>,
    exit: Exit.Exit<C, E>,
  ): void {
    const opened = Deferred.isDoneUnsafe(answer);
    if (this.entries.get(runId) === live) {
      // A stop still committing holds a launch off until its rows are in.
      if (live.stop !== null && !live.stop.committed)
        this.entries.set(runId, {
          kind: 'ending',
          done: Deferred.makeUnsafe<void>(),
        });
      else this.entries.delete(runId);
      this.publishHeld();
      if (opened) this.init.wake(runId);
    }
    // Once the run has left: a launcher told the run did not open finds
    // the id free.
    if (Exit.isFailure(exit))
      Deferred.doneUnsafe(
        answer,
        Exit.failCause(this.notOpened(runId, exit.cause)),
      );
  }

  /** Why a run's fiber exited before its opening answered, as its launch
   *  is told: its own failure, or, cut by an interruption, the session's
   *  close or a stop. */
  private notOpened<E>(
    runId: RunId,
    cause: Cause.Cause<E>,
  ): Cause.Cause<E | LaunchRefusal> {
    if (!Cause.hasInterruptsOnly(cause)) return cause;
    return Cause.fail(this.closedRefusal() ?? new RunStopped({ runId }));
  }

  /**
   * The run's fiber: the opening, interruptible, in the fiber's own scope;
   * then the answer to its launcher and the run, interruptible, whose
   * every exit reaches the run's end. A stop interrupts either: one that
   * cuts the opening, or meets one that failed, ends the run on the rows
   * the opening committed ({@link endUnopened}).
   */
  private program<A, E, B, C>(
    runId: RunId,
    launch: Launch<A, E, B, C>,
    answer: Deferred.Deferred<A, E | LaunchRefusal>,
  ): Effect.Effect<C, E, AgentRunServices> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Effect.exit(restore(launch.open)), (opened) => {
        if (Exit.isFailure(opened))
          return Effect.andThen(
            this.endUnopened(runId),
            Effect.failCause(opened.cause),
          );
        const { value } = opened;
        return Deferred.succeed(answer, value).pipe(
          Effect.andThen(Effect.exit(restore(launch.run(value)))),
          Effect.flatMap((exit) => launch.end(value, exit)),
        );
      }),
    ).pipe(
      Effect.scoped,
      Effect.provide(workspaceEnvironmentLayer(this.init.roots.workspace)),
    );
  }

  /**
   * The end of a run whose opening a stop cut, or which failed with a stop
   * asked: its `run.stop` and CANCELLED end, if it has rows and no end. The
   * stop wrote its row first when the run had rows then, and stopped the
   * runs under it; an opening it cut may have committed rows after that
   * (its batch is uninterruptible), which end here with the stop's reason.
   * One the store refused is said: the run reads as interrupted at its
   * next open.
   */
  private endUnopened(runId: RunId): Effect.Effect<void> {
    return Effect.suspend(() => {
      const entry = this.entries.get(runId);
      const stop = entry?.kind === 'live' ? entry.stop : null;
      if (stop === null) return Effect.void;
      return this.inSession(stopRun(runId, stop.reason, true)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Run ${runId}: the stop that cut its opening was not recorded`,
          ).pipe(Effect.annotateLogs({ data: cause })),
        ),
        Effect.asVoid,
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
   * Stop a run (`RunsShape.stop`). Its `run.stop` row first, so a child
   * registering under it meanwhile is refused (`registrationRows`) and none
   * escapes; then every run held here under it, at any depth; then the
   * interruption of the fiber driving it here. A run no fiber drives here
   * gets its end in the same batch as the stop. A run still opening is
   * stopped the same way: its row if it has rows yet, then its fiber's
   * interruption, which refuses its launch; rows its opening committed
   * meanwhile end with the stop ({@link endUnopened}). A run whose id has
   * nothing here and no rows yet is a launch still on its way, refused
   * when it arrives. A run a file operation holds is stopped once the
   * operation ends. A
   * closing session records no stop: the fiber is interrupted and the run
   * left as its rows stand.
   */
  stop(runId: RunId, reason: RunStopReason): Effect.Effect<boolean, Error> {
    return Effect.suspend(() =>
      this.closing
        ? Effect.succeed(this.interrupt(runId))
        : this.stopping(runId, reason, true),
    );
  }

  /**
   * One stop of one run: what it does is decided and marked on the run in
   * one step (`claimStop`), carried out, and the mark finished on every
   * exit. `cascade` is whether it reaches the runs under it and ends a run
   * no fiber here drives; a stop under an ancestor's cascade does neither,
   * the ancestor's covering the whole tree. Answers whether a fiber here
   * took the stop.
   */
  private stopping(
    runId: RunId,
    reason: RunStopReason,
    cascade: boolean,
  ): Effect.Effect<boolean, Error> {
    const under = cascade ? this.stopUnder(runId, reason) : Effect.void;
    return Effect.acquireUseRelease(
      Effect.sync(() => this.claimStop(runId, reason, cascade)),
      (claim): Effect.Effect<StopResult, Error> => {
        switch (claim.kind) {
          case 'done':
            return Effect.succeed({ took: claim.took, unknown: false });
          case 'again':
            return Effect.map(
              Effect.andThen(
                claim.after,
                this.stopping(runId, reason, cascade),
              ),
              (took) => ({ took, unknown: false }),
            );
          // Its `run.stop` row, then the runs under it, then its fiber's
          // interruption.
          case 'live':
            return this.inSession(stopRun(runId, reason, false)).pipe(
              Effect.andThen(under),
              Effect.andThen(
                Effect.sync(() => claim.live.fiber.interruptUnsafe()),
              ),
              Effect.as({ took: true, unknown: false }),
            );
          // No fiber here drives it: its end commits with its stop. No
          // rows: the launch has not registered yet.
          case 'ending':
            return this.inSession(stopRun(runId, reason, true)).pipe(
              Effect.tap((known) => (known ? under : Effect.void)),
              Effect.map((known) => ({ took: false, unknown: !known })),
            );
        }
      },
      (claim, exit) =>
        Effect.sync(() => {
          if (claim.kind === 'live') {
            const entry = this.entries.get(runId);
            // Committed, it holds until the fiber it interrupted ends; one
            // that failed can be asked again.
            if (entry === claim.live)
              claim.live.stop = Exit.isSuccess(exit)
                ? { reason, committed: true }
                : null;
            // The fiber exited as the rows committed: what waited for them
            // goes on.
            else if (entry?.kind === 'ending') this.pass(runId, entry);
          } else if (claim.kind === 'ending')
            // A run with no rows: its launch is refused when it arrives.
            this.pass(
              runId,
              claim.ending,
              Exit.isSuccess(exit) && exit.value.unknown
                ? { kind: 'pending', reason }
                : undefined,
            );
        }),
    ).pipe(Effect.map(({ took }) => took));
  }

  /** A stop's first step: what the run's state here makes of it, marked on
   *  the run so a second stop records nothing and a launch waits. */
  private claimStop(
    runId: RunId,
    reason: RunStopReason,
    cascade: boolean,
  ): StopClaim {
    const entry = this.entries.get(runId);
    switch (entry?.kind) {
      case 'live':
        if (entry.stop !== null) return { kind: 'done', took: true };
        entry.stop = { reason, committed: false };
        return { kind: 'live', live: entry };
      case 'ending':
      case 'pending':
        return { kind: 'done', took: false };
      case 'busy':
        return cascade
          ? { kind: 'again', after: Deferred.await(entry.done) }
          : { kind: 'done', took: false };
    }
    if (!cascade) return { kind: 'done', took: false };
    // A launch is refused until the end is in.
    const ending: Ending = {
      kind: 'ending',
      done: Deferred.makeUnsafe<void>(),
    };
    this.entries.set(runId, ending);
    return { kind: 'ending', ending };
  }

  /** A stop of `runId` stops every run held here under it, at any depth,
   *  each with no cascade of its own (this one covers the whole tree). */
  private stopUnder(
    runId: RunId,
    reason: RunStopReason,
  ): Effect.Effect<void, Error> {
    return Effect.flatMap(this.heldUnder(runId), (held) =>
      Effect.forEach(held, (id) => this.stopping(id, reason, false), {
        discard: true,
      }),
    );
  }

  /** The session is closing: refuse every run started from here on, and
   *  interrupt the fiber of every run driven here. Nothing is written: a
   *  run the close cuts is left as its rows stand and reads as interrupted,
   *  resumable, at the next open, as after a crash. A run still opening is
   *  interrupted the same way, and its launch told the session is closing. */
  interruptAll(): void {
    if (this.session === 'open') this.session = 'closing';
    for (const [runId, entry] of this.entries) {
      // A launch that never started is refused from here on anyway.
      if (entry.kind === 'pending') this.entries.delete(runId);
      else if (entry.kind === 'live') entry.fiber.interruptUnsafe();
    }
  }

  /** Resolve once no fiber here drives `runId` (or any run). */
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
