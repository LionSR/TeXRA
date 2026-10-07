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
  type Cause,
} from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { AgentEvent } from '@agent/trace';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import { aggregateId as qualifyAggregateId, type RunId } from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';

import { RunFailure } from './errors.js';
import type { Run } from './sessions.js';

/** A run that returned without ever publishing its stream: the launcher's
 *  contract broke, and a caller waiting on admission must hear it. */
const NEVER_ENTERED = 'The run ended without entering the session.';

const CHANNEL = 'agentPackage';

/**
 * How many trace events a run holds for a reader that has yet to attach.
 * The buffer exists only to bridge admission to the reader's first pull, so
 * a run that passes it with nobody reading has no reader: it says so and
 * detaches its trace, instead of retaining a long run's whole trace (every
 * `stream.chunk` included) until the run settles. A reader that did attach
 * is never dropped: past its first pull the buffer is the reader's, and
 * nothing here discards what it has yet to read.
 */
const TRACE_HANDOVER_EVENTS = 512;

/** A run's trace on its way to its one reader. */
interface TraceHandover {
  /** The launch's tap: every trace event, from the run's first. */
  readonly offer: (event: AgentEvent) => void;
  /** End the trace with the run's exit, dropping what nobody read. */
  readonly settle: (
    exit: Exit.Exit<RunEndResult, RunFailure>,
  ) => Effect.Effect<void>;
  /** The reader's stream: running it once is the contract, and ending it
   *  detaches the trace while the run continues. */
  readonly events: Stream.Stream<AgentEvent, RunFailure>;
}

/**
 * The trace a run holds for a reader that has yet to attach. It holds at
 * most {@link TRACE_HANDOVER_EVENTS} before the first pull: a run past that
 * with nobody reading has no reader, so it detaches and says so at its end.
 * Past the first pull the buffer is the reader's, and nothing drops it.
 */
const traceHandover = (runId: RunId): Effect.Effect<TraceHandover> =>
  Effect.gen(function* () {
    const trace = yield* Queue.unbounded<AgentEvent, RunFailure | Cause.Done>();
    let tapping = true;
    let reading = false;
    let buffered = 0;
    /** Stop taking the run's trace events: the reader's close does it while
     *  the run continues, and the run's settlement does it for a reader that
     *  never came. */
    const release = (): void => {
      tapping = false;
    };
    return {
      offer: (event) => {
        if (!tapping) return;
        if (!reading && (buffered += 1) > TRACE_HANDOVER_EVENTS) {
          release(); // `settle` logs it: no fiber here to log from.
          return;
        }
        Queue.offerUnsafe(trace, event);
      },
      settle: (exit) =>
        Effect.gen(function* () {
          release();
          if (buffered > TRACE_HANDOVER_EVENTS) {
            yield* Effect.logWarning(
              `Run ${runId} buffered ${TRACE_HANDOVER_EVENTS} trace events with no reader attached; its trace was detached. Iterate the run's events in the turn that starts it, or await only its result.`,
            ).pipe(withLogChannel(CHANNEL));
          }
          // A run nobody read retains nothing: what it buffered goes with it.
          if (!reading) yield* Effect.orDie(Queue.clear(trace));
          if (Exit.isFailure(exit)) yield* Queue.failCause(trace, exit.cause);
          else yield* Queue.end(trace);
        }),
      events: Stream.unwrap(
        Effect.sync(() => {
          reading = true;
          return Stream.fromQueue(trace);
        }),
      ).pipe(Stream.ensuring(Effect.sync(release))),
    };
  });

/** What a launch reports to its handle: every trace event, from the run's
 *  first, and the moment the run exists in its session. */
interface LaunchHooks {
  /** Whether the handoff was abandoned before the run could be stopped by
   *  id: a launch that reads it starts no run once it is true. */
  readonly isCancellationRequested: () => boolean;
  readonly onTraceEvent: (event: AgentEvent) => void;
  readonly onRunResolved: () => void;
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
 * The handoff is all-or-nothing, which is what lets a caller treat the
 * `Run` as the only handle on the run: this either returns one, or it ends
 * every fiber it started. There is no exit in which a run keeps working
 * with nobody holding it.
 */
export function handOver(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
  launch: Launch,
): Effect.Effect<Run, RunFailure> {
  return Effect.gen(function* () {
    const trace = yield* traceHandover(runId);
    const admitted = yield* Deferred.make<void, RunFailure>();
    // Settling a run that was admitted changes nothing here; one that never
    // was fails its admission with its own failure, or with the launcher's
    // broken contract.
    const settle = (
      exit: Exit.Exit<RunEndResult, RunFailure>,
    ): Effect.Effect<void> =>
      trace.settle(exit).pipe(
        Effect.andThen(
          Exit.isFailure(exit)
            ? Deferred.failCause(admitted, exit.cause)
            : Deferred.fail(
                admitted,
                new RunFailure({
                  cause: new Error(NEVER_ENTERED),
                  message: NEVER_ENTERED,
                }),
              ),
        ),
      );
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
      return session.runs.interrupt(runId);
    };
    const spawned: Fiber.Fiber<unknown, Error>[] = [];
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.forkDetach(
          launch({
            // The run's trace is built with this tap, so it hears the run
            // from its first event.
            onTraceEvent: trace.offer,
            isCancellationRequested: () => cancelled,
            onRunResolved: () => {
              Deferred.doneUnsafe(admitted, Effect.void);
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
        yield* restore(Deferred.await(admitted));
        const view = session.view.changes.pipe(
          // The level replays on subscribe, and the fold lands the run's
          // `run.start` asynchronously, so a replayed level can predate the
          // run.
          Stream.dropWhile((level) => !level.runs.has(runId)),
          // The view is the end condition: the first level holding the
          // run's durable outcome is the last element.
          Stream.takeUntil(
            (level) => level.runs.get(runId)?.durableOutcome != null,
          ),
        );
        // The transcript tier folds only for subscribed aggregates, on a
        // port of this run's own: its stream now, its descendants as the
        // view gains them. The port is never cleared, by choice: the run's
        // rows stay resident for the life of the package session, as a
        // TUI's do.
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
          ),
          { startImmediately: true },
        );
        spawned.push(drain);
        return {
          runId,
          result: Fiber.join(runFiber).pipe(
            Effect.flatMap((value) => Effect.as(Fiber.join(drain), value)),
          ),
          view,
          events: trace.events,
          interrupt: Effect.suspend(() =>
            interruptLaunch() ? Effect.void : Fiber.interrupt(runFiber),
          ),
        };
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.suspend(() => {
              interruptLaunch();
              return Fiber.interruptAll(spawned);
            }),
      ),
    );
  });
}
