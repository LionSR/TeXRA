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
  Option,
  Queue,
  Stream,
  Cause,
} from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { registryOf } from '@agent/runtime/runRegistry';
import type { AgentEvent } from '@agent/trace';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  type RunId,
} from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';

import { RunFailure, TraceUnavailable } from './errors.js';
import type { Run } from './sessions.js';

/** A run that returned without ever publishing its stream: a resumed run
 *  that ended before its activation committed (its result's error says
 *  why), or a launcher whose contract broke. A caller waiting on admission
 *  must hear it. */
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
    exit: Exit.Exit<unknown, RunFailure>,
  ) => Effect.Effect<void>;
  /** The reader's stream: running it once is the contract, and ending it
   *  detaches the trace while the run continues. */
  readonly events: Stream.Stream<AgentEvent, RunFailure | TraceUnavailable>;
}

/**
 * The trace a run holds for a reader that has yet to attach. It holds at
 * most {@link TRACE_HANDOVER_EVENTS} before the first pull: a run past that
 * with nobody reading has no reader, so it detaches and says so at its end.
 * Past the first pull the buffer is the reader's, and nothing drops it.
 */
const traceHandover = Effect.fn('runHandle.traceHandover')(function* (
  runId: RunId,
): Effect.fn.Return<TraceHandover> {
  const trace = yield* Queue.unbounded<AgentEvent, RunFailure | Cause.Done>();
  let tapping = true;
  let reading = false;
  /** How the run settled before any reader came: a failed run's reader
   *  hears its failure, which the queue holds; a succeeded one's nothing. */
  let settledUnread: 'succeeded' | 'failed' | null = null;
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
        if (!reading)
          settledUnread = Exit.isSuccess(exit) ? 'succeeded' : 'failed';
        if (!reading && buffered > TRACE_HANDOVER_EVENTS) {
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
      Effect.suspend(() => {
        // A reader past the buffer, or after an unread settlement, has no
        // trace left to read: it hears why rather than an empty stream.
        // A failed run's reader hears its failure from the queue instead.
        let lost: TraceUnavailable['reason'] | null = null;
        if (settledUnread === 'succeeded') lost = 'ended';
        if (buffered > TRACE_HANDOVER_EVENTS) lost = 'truncated';
        if (settledUnread === 'failed') lost = null;
        if (lost === null) {
          reading = true;
          return Effect.succeed(Stream.fromQueue(trace));
        }
        const message = `Run ${runId}'s trace is ${lost === 'ended' ? 'gone: the run settled with no reader attached' : 'detached: it passed the handover buffer before a reader attached'}.`;
        return Effect.logWarning(message).pipe(
          withLogChannel(CHANNEL),
          Effect.andThen(
            Effect.fail(new TraceUnavailable({ runId, reason: lost, message })),
          ),
        );
      }),
    ).pipe(Stream.ensuring(Effect.sync(release))),
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
type Launch<A> = (
  hooks: LaunchHooks,
) => Effect.Effect<RunEndResult | A, RunFailure, ProcessServices>;

/**
 * Launch `runId` on `session` and hand back its {@link Run} once it exists
 * there; a launch that fails first fails this with its own error.
 *
 * A parent-owned resume returns its owner after releasing its trace. An
 * interrupted handoff ends its observer fibers; before admission it also
 * stops a launch it owns, unless another caller joined. A caller that joined
 * a resume already in flight only abandons its own wait and events. Every
 * caller reads the run's one trace port (`session.trace.listen`) from its
 * own handoff on.
 */
export function handOver<A extends { readonly ownedBy: RunId } = never>(
  session: RuntimeSessionHandle,
  services: Context.Context<ProcessServices>,
  runId: RunId,
  launch: Launch<A>,
): Effect.Effect<Run | A, RunFailure> {
  return Effect.gen(function* () {
    const trace = yield* traceHandover(runId);
    const unlisten = session.trace.listen(runId, trace.offer);
    const admitted = yield* Deferred.make<CommitOrdinal | A, RunFailure>();
    // Close the trace before answering a redirect or an unadmitted failure.
    // An admission already committed keeps its original answer.
    const settle = (
      exit: Exit.Exit<RunEndResult | A, RunFailure>,
    ): Effect.Effect<void> =>
      Effect.sync(unlisten).pipe(
        Effect.andThen(trace.settle(exit)),
        Effect.andThen(
          Effect.suspend(() => {
            if (Exit.isFailure(exit))
              return Deferred.failCause(admitted, exit.cause);
            if ('ownedBy' in exit.value)
              return Deferred.succeed(admitted, exit.value);
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
    // Only admission is interruptible. The exit handler outside the mask
    // also covers an interrupt at return, before the caller gets the Run.
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
            // Use the embedder's scoped clients and logger.
            Effect.provideContext(services),
          ),
          { startImmediately: true },
        );
        spawned.push(runFiber);
        const activation = yield* restore(Deferred.await(admitted));
        // Redirects arrive after trace cleanup and open no view subscription.
        if (typeof activation !== 'number') return activation;
        const view = session.view.changes.pipe(
          // A replay can precede this activation, including its old outcome.
          Stream.dropWhile(
            (level) => level.cursor < activation || !level.runs.has(runId),
          ),
          // End at this activation's first durable outcome.
          Stream.takeUntil(
            (level) => level.runs.get(runId)?.durableOutcome != null,
          ),
        );
        // Fold this run and its descendants only while its port is subscribed.
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
        // Result waits for the final fold even without a view reader, and
        // fails when the fold dies. The drain releases transcript interest.
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
        return {
          runId,
          result: Fiber.join(runFiber).pipe(
            Effect.flatMap((value) =>
              'ownedBy' in value
                ? Effect.die(
                    new Error(`Run ${runId} redirected after admission.`),
                  )
                : Effect.as(Fiber.join(drain), value),
            ),
          ),
          view,
          events: trace.events,
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
          : Effect.gen(function* () {
              // A joiner abandons only its observation; failures already settled.
              if (!Cause.hasInterrupts(exit.cause) || joined)
                return yield* Fiber.interruptAll(spawned);
              // Redirects never acquired the run, even at the return boundary.
              const answer = yield* Deferred.poll(admitted);
              if (Option.isSome(answer)) {
                const redirected = yield* Effect.match(answer.value, {
                  onFailure: () => false,
                  onSuccess: (value) => typeof value !== 'number',
                });
                if (redirected) return yield* Fiber.interruptAll(spawned);
              }
              if (session.followUps.resumes.joined(runId)) return;
              interruptLaunch();
              return yield* Fiber.interruptAll(spawned);
            }),
      ),
    );
  });
}
