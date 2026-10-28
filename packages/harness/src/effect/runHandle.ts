/**
 * The {@link Run} handle of `@texra-ai/harness`: how a launch, fresh or
 * resumed, becomes the one value an embedder holds. Every decision about a
 * run's handle is stated here, once: which level is the run's first, when
 * its transcript interest changes, when its drain ends, what its trace
 * holds for a reader that has yet to attach, and which failure wins.
 * `session.start` and `session.resume` (`sessionPrograms.ts`) differ only in
 * the launch they hand {@link handOver}.
 */
import {
  type Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Stream,
  Cause,
} from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { registryOf } from '@agent/runtime/runRegistry';
import type { AgentEvent } from '@agent/trace';
import { replayTrace } from '@controllers/session/runTrace';
import type { ProcessServices } from '@platform/processRuntime';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  type RunId,
} from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';

import { RunFailure } from './errors.js';
import type { Run } from './sessions.js';

/** A run that returned without ever publishing its stream: a resumed run
 *  that ended before its activation committed (its result's error says
 *  why), or a launcher whose contract broke. A caller waiting on admission
 *  must hear it. */
const NEVER_ENTERED = 'The run ended without entering the session.';

/**
 * How many trace events a run holds for a first reader that has yet to
 * attach. The buffer only bridges admission to that reader's first pull: a
 * run that passes it with nobody reading drops it, rather than keeping a
 * long run's whole trace (every `stream.chunk` included) in memory, and a
 * reader that comes later reads the trace back from the session instead
 * (`replayTrace`). Past its first pull the buffer is the reader's,
 * and nothing here discards what it has yet to read.
 */
const TRACE_HANDOVER_EVENTS = 512;

/** A run's trace on its way to its first reader. */
interface TraceHandover {
  /** The launch's tap: every trace event, from the run's first. */
  readonly offer: (event: AgentEvent) => void;
  /** End the trace with the run's exit, dropping what nobody read. */
  readonly settle: (
    exit: Exit.Exit<RunEndResult, RunFailure>,
  ) => Effect.Effect<void>;
  /** The events of the activation admitted at `activation`, for each
   *  reader: the buffer for the first that comes while it is whole, the
   *  session's replay for any other. Ending a read stops that reader, not
   *  the run. */
  readonly events: (
    result: Effect.Effect<RunEndResult, RunFailure>,
    activation: CommitOrdinal,
  ) => Stream.Stream<AgentEvent, RunFailure>;
}

/**
 * The trace a run holds for its first reader. It holds at most
 * {@link TRACE_HANDOVER_EVENTS} before that reader's first pull; past that,
 * or once a successful run has ended unread, the buffer is gone and every
 * reader gets the replay.
 */
const traceHandover = Effect.fn('runHandle.traceHandover')(function* (
  session: RuntimeSessionHandle,
  runId: RunId,
): Effect.fn.Return<TraceHandover> {
  const trace = yield* Queue.unbounded<AgentEvent, RunFailure | Cause.Done>();
  let tapping = true;
  let claimed = false;
  /** Whether the buffer still holds the whole trace for a first reader. A
   *  failed run's unread buffer is kept: it ends with the failure. */
  let whole = true;
  let buffered = 0;
  const release = (): void => {
    tapping = false;
  };
  return {
    offer: (event) => {
      if (!tapping) return;
      if (!claimed && (buffered += 1) > TRACE_HANDOVER_EVENTS) {
        release();
        whole = false;
        return;
      }
      Queue.offerUnsafe(trace, event);
    },
    settle: (exit) =>
      Effect.gen(function* () {
        release();
        // A successful run nobody read keeps nothing: what it buffered
        // goes with it, and a later reader replays the trace.
        if (!claimed && Exit.isSuccess(exit)) whole = false;
        // A buffer no reader can take any more holds nothing.
        if (!claimed && !whole) yield* Effect.orDie(Queue.clear(trace));
        if (Exit.isFailure(exit)) yield* Queue.failCause(trace, exit.cause);
        else yield* Queue.end(trace);
      }),
    events: (result, activation) =>
      Stream.suspend(() => {
        if (claimed || !whole)
          return replayTrace(
            session.view.inputs,
            runId,
            result,
            session.log,
            activation,
          );
        claimed = true;
        return Stream.fromQueue(trace).pipe(
          Stream.ensuring(Effect.sync(release)),
        );
      }),
  };
});

/** What a launch reports to its handle: the moment the run exists in its
 *  session, and that it joined a resume already in flight. */
interface LaunchHooks {
  /** Whether the handoff was abandoned before the run could be stopped by
   *  id: a launch that reads it starts no run once it is true. */
  readonly isCancellationRequested: () => boolean;
  /** The run is admitted at `commit`, its activation's: the batch with its
   *  `run.start` or its `run.activate`. */
  readonly onAdmitted: (
    runId: RunId,
    commit: CommitOrdinal,
  ) => Effect.Effect<void>;
  readonly onJoined: () => void;
}

/** One launch of `runId`, fresh or resumed, wired to the hooks its handle
 *  hands it; it ends with the run's result. */
type Launch = (
  hooks: LaunchHooks,
) => Effect.Effect<RunEndResult, RunFailure, ProcessServices>;

/**
 * Launch `runId` on `session` and hand back its {@link Run} once it exists
 * there; a launch that fails first fails this with its own error.
 *
 * The handoff is all-or-nothing for the caller that launched: this either
 * returns a `Run`, or it ends every fiber it started, and abandoned before
 * admission it stops the launch, unless another caller joined it, when it
 * leaves and the run goes on for them. A caller that joined a resume already
 * in flight is an observer: its interruption ends only its own wait and its
 * events, never the run. Every caller reads the run's events from the run's
 * one trace port (`session.trace.listen`), from its own handoff on.
 */
export function handOver(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
  launch: Launch,
): Effect.Effect<Run, RunFailure> {
  return Effect.gen(function* () {
    const trace = yield* traceHandover(session, runId);
    const unlisten = session.trace.listen(runId, trace.offer);
    const admitted = yield* Deferred.make<CommitOrdinal, RunFailure>();
    // Settling a run that was admitted changes nothing here; one that never
    // was fails its admission with its own failure, its result's error, or
    // the launcher's broken contract.
    const settle = (
      exit: Exit.Exit<RunEndResult, RunFailure>,
    ): Effect.Effect<void> =>
      Effect.sync(unlisten).pipe(
        Effect.andThen(trace.settle(exit)),
        Effect.andThen(
          Effect.suspend(() => {
            if (Exit.isFailure(exit))
              return Deferred.failCause(admitted, exit.cause);
            const message = exit.value.error?.message ?? NEVER_ENTERED;
            const failure = new RunFailure({
              cause: new Error(message),
              message,
            });
            return Deferred.fail(admitted, failure);
          }),
        ),
      );
    let joined = false;
    // The launch and the drain are the run's, and until the caller holds
    // the `Run` that names them they are nobody's: whatever ends this
    // handoff short of that ends them too. So the handoff is
    // uninterruptible but for the admission wait, where the launch's own
    // abort signal is what an interruption reaches, and the exit handler
    // outside the mask covers the rest, the boundary included: an interrupt
    // that lands while the tail runs is raised the moment the mask lifts,
    // with a `Run` built that reaches no one.
    let cancelled = false;
    const interruptLaunch = (): boolean => {
      cancelled = true;
      return registryOf(session.runs).interrupt(runId);
    };
    const spawned: Fiber.Fiber<unknown, Error>[] = [];
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.forkDetach(
          launch({
            isCancellationRequested: () => cancelled,
            onAdmitted: (_, commit) =>
              Deferred.done(admitted, Exit.succeed(commit)),
            onJoined: () => {
              joined = true;
            },
          }).pipe(
            Effect.onExit(settle),
            // The embedder owns this runtime. Provide the process's existing
            // context: tool I/O shares its scoped clients, `settle` its logger.
            Effect.provideContext(services),
          ),
          { startImmediately: true },
        );
        spawned.push(runFiber);
        const activation = yield* restore(Deferred.await(admitted));
        const view = session.view.changes.pipe(
          // The level replays on subscribe, and the fold lands the
          // activation's row asynchronously, so a replayed level can predate
          // it: the run absent, or a resumed run with the outcome of the
          // activation before.
          Stream.dropWhile(
            (level) => level.cursor < activation || !level.runs.has(runId),
          ),
          // The view is the end condition: the first level holding this
          // activation's durable outcome is the last element.
          Stream.takeUntil(
            (level) => level.runs.get(runId)?.durableOutcome != null,
          ),
        );
        // The transcript tier folds only for subscribed aggregates, on a
        // port of this run's own: its stream now, its descendants as the
        // view gains them, cleared when the drain ends so a long-lived
        // session does not keep every run's rows resident.
        const port = `sdk/${runId}`;
        let subscribed = '';
        const interest = (ids: readonly RunId[]): Effect.Effect<void> =>
          Effect.suspend(() => {
            const key = ids.join('\0');
            if (key === subscribed) return Effect.void;
            subscribed = key;
            return session.view.subscribe(
              port,
              ids.map((id) => ({
                id: qualifyAggregateId('run', id),
                fromSeq: 0,
              })),
            );
          });
        yield* interest([runId]);
        // The package owns this drain: the descendants join the
        // subscription as the view gains them, and the run's `result` waits
        // for its final fold even when nobody reads `view`, and fails if
        // the fold dies first.
        const drain = yield* Effect.forkDetach(
          Stream.runDrain(
            view.pipe(
              Stream.tap((level) =>
                interest(descendantRuns(level, runId, { includeRoot: true })),
              ),
            ),
          ).pipe(Effect.ensuring(session.view.subscribe(port, []))),
          { startImmediately: true },
        );
        spawned.push(drain);
        const result = Fiber.join(runFiber).pipe(
          Effect.flatMap((value) => Effect.as(Fiber.join(drain), value)),
        );
        return {
          runId,
          result,
          view,
          events: trace.events(result, activation),
          interrupt: Effect.suspend(() =>
            !joined && interruptLaunch()
              ? Effect.void
              : Fiber.interrupt(runFiber),
          ),
        };
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.suspend(() => {
              // Only a launcher's abandoned handoff stops the launch by id
              // (one the launch failed has settled it), and only while no
              // other caller joined it; a joiner ends only its own wait.
              if (!Cause.hasInterrupts(exit.cause) || joined)
                return Fiber.interruptAll(spawned);
              if (session.followUps.resumes.joined(runId)) return Effect.void;
              interruptLaunch();
              return Fiber.interruptAll(spawned);
            }),
      ),
    );
  });
}
