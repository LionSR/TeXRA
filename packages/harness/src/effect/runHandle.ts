/**
 * The {@link Run} handle of `@texra-ai/harness`: how a launch, fresh or
 * resumed, becomes the one value an embedder holds. Every decision about a
 * run's handle is stated here, once: which level is the run's first, when
 * its transcript interest changes, when its drain ends, and which failure
 * wins.
 * `session.start` and `session.resume` (`sessionPrograms.ts`) differ only in
 * the launch they hand {@link handOver}.
 */
import {
  type Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Stream,
  Cause,
} from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { registryOf } from '@agent/runtime/runRegistry';
import { replayTrace } from '@controllers/session/runTrace';
import type { ProcessServices } from '@platform/processRuntime';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  RUN_OUTCOME,
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
 * A run's end as its handle reports it. A stop interrupts the run's fiber,
 * which re-raises the interruption once the run's end commits: that stored
 * end is how the run ended, and the interruption, passed on, would interrupt
 * whoever reads it. With none stored, or a failed one, the interruption
 * stays: a joiner that left a run still going, an end that did not save.
 */
const reportedEnd = (
  session: RuntimeSessionHandle,
  runId: RunId,
  exit: Exit.Exit<RunEndResult, RunFailure>,
): Effect.Effect<RunEndResult, RunFailure> =>
  Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)
    ? exit
    : session.log.facts(runId).pipe(
        Effect.map((facts) => facts?.end ?? null),
        // An end that cannot be read fails the result with why, rather
        // than passing the stop on as if none were stored.
        Effect.mapError(
          (error) =>
            new RunFailure({
              cause: error,
              message: `Run ${runId} stopped; its stored end could not be read: ${error.message}`,
            }),
        ),
        Effect.flatMap((end) =>
          end === null || end.outcome === RUN_OUTCOME.FAILED
            ? exit
            : Effect.succeed({
                runId,
                outcome: end.outcome,
                output: end.output,
              }),
        ),
      );

/** What a launch reports to its handle: the moment the run exists in its
 *  session. */
interface LaunchHooks {
  /** The run is admitted at `commit`, its activation's: the batch with its
   *  `run.start` or its `run.activate`; `joined`: this caller joined a
   *  resume already in flight, an observer. */
  readonly onAdmitted: (
    runId: RunId,
    commit: CommitOrdinal,
    joined?: boolean,
  ) => Effect.Effect<void>;
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
 * The handoff is all-or-nothing for its caller: this either returns a
 * `Run`, or it ends every fiber it started. A launch's caller is one of the
 * resume's callers, so abandoning the handoff stops the launch unless
 * another caller still waits on it (`resumeRun`); once a `Run` is returned
 * only a stop or the session's close ends the run. A caller that joined a
 * resume already in flight is an observer: its `interrupt` ends only its
 * own wait and its events, never the run.
 */
export function handOver(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
  launch: Launch,
): Effect.Effect<Run, RunFailure> {
  return Effect.gen(function* () {
    const admitted = yield* Deferred.make<CommitOrdinal, RunFailure>();
    // This activation's end, read once as it exits: a resume writes another.
    const ended = yield* Deferred.make<RunEndResult, RunFailure>();
    let joined = false;
    // Settling a run that was admitted changes nothing here; one that never
    // was fails its admission with its own failure, its result's error, or
    // the launcher's broken contract.
    const settle = (
      exit: Exit.Exit<RunEndResult, RunFailure>,
    ): Effect.Effect<void> =>
      Effect.exit(reportedEnd(session, runId, exit)).pipe(
        Effect.flatMap((end) => Deferred.done(ended, end)),
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
    // The launch and the drain are the run's, and until the caller holds the
    // `Run` that names them they are nobody's: whatever ends this handoff short
    // of that ends them too. So the handoff is uninterruptible but for the
    // admission wait, where an interruption ends the launch fiber (which stops
    // its run: `resumeRun`, `rootRun`), and the
    // exit handler outside the mask covers the rest, the boundary included: an
    // interrupt that lands while the tail runs is raised the moment the mask
    // lifts, with a `Run` built that reaches no one.
    const interruptLaunch = (): boolean =>
      registryOf(session.runs).interrupt(runId);
    const spawned: Fiber.Fiber<unknown, Error>[] = [];
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.forkDetach(
          launch({
            onAdmitted: (_, commit, observer = false) => {
              joined = observer;
              return Deferred.done(admitted, Exit.succeed(commit));
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
        // The package owns this drain: the descendants join the subscription as
        // the view gains them, and the run's `result` waits for its final fold
        // even when nobody reads `view`, and fails if the fold dies first.
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
        const result = Effect.tap(Deferred.await(ended), Fiber.join(drain));
        return {
          runId,
          result,
          view,
          // Every reader replays this activation from the session's rows.
          events: replayTrace(session, runId, activation, result),
          // A launch not yet admitted is stopped where it stands, and then
          // by id, in case it started a run meanwhile.
          interrupt: Effect.suspend(() => {
            if (joined) return Fiber.interrupt(runFiber);
            if (interruptLaunch()) return Effect.void;
            return Fiber.interrupt(runFiber).pipe(
              Effect.andThen(Effect.sync(interruptLaunch)),
            );
          }),
        };
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.sync(() => {
              // Handed out: leaving it no longer stops a resume.
              const resuming = registryOf(session.runs).attemptOf(runId);
              if (resuming) resuming.handedOff = true;
            })
          : // The launch leaves with its caller (`resumeRun`, `rootRun`).
            Fiber.interruptAll(spawned),
      ),
    );
  });
}
