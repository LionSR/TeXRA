/**
 * The {@link Run} of `@texra-ai/harness`: one activation of a run, as a
 * view over its session's rows. It is `(session, runId, activation)`, the
 * activation's commit, and holds nothing: the run is its registry's, which
 * a launch or resume hands it to before this is built
 * (`sessionPrograms.ts`), so a reader that leaves, or a handle nobody reads,
 * changes nothing about the run.
 */
import { Context, Effect, Stream, SubscriptionRef } from 'effect';

import { SessionRequests } from '@agent/runtime/requests';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { getRunRecords } from '@agent/storage/runRecords';
import { replayTrace } from '@controllers/session/runTrace';
import {
  type CommitOrdinal,
  qualifyAggregateId,
  type RunId,
  type TranscriptSubscription,
} from '@shared/schemas';
import { boundsLifecycle } from '@shared/session/runFacts';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { descendantRuns } from '@shared/session/sessionView';
import type { SessionView } from '@shared/session/readonlyViews';

import { RunFailure } from './errors.js';
import type { Run } from './sessions.js';

/** What an activation's view is read over: a session view's levels, and
 *  the port its reader keeps the run's transcripts subscribed on (`set`
 *  empty: the port's subscriptions end). A session handle's own view, or a
 *  window's view of a session elsewhere. */
export interface ActivationViewSource {
  readonly current: () => SessionView;
  readonly changes: Stream.Stream<SessionView>;
  readonly subscribe: (
    port: string,
    set: readonly TranscriptSubscription[],
  ) => Effect.Effect<void>;
}

/**
 * `Run.view` of `runId`'s activation at `activation`, for every reader of
 * it: the levels from the first that holds the activation, the run and its
 * transcript, to the first that holds the activation's durable outcome, or
 * shows the run gone. The transcript tier folds only for subscribed
 * aggregates: while the view is read, on a port of its own, the run and its
 * descendants are subscribed, taken before the first level is, so even an
 * ended run's one level holds its transcript; descendants join as the view
 * gains them.
 */
export function activationView(
  source: ActivationViewSource,
  runId: RunId,
  activation: CommitOrdinal,
): Stream.Stream<SessionView> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const port = `sdk/${runId}/${crypto.randomUUID()}`;
      let subscribed = '';
      const interest = (level: SessionView) => {
        // The run itself even before the view holds it.
        const ids = [
          runId,
          ...descendantRuns(level, runId, { includeRoot: false }),
        ];
        if (ids.join('\0') === subscribed) return Effect.void;
        subscribed = ids.join('\0');
        return source.subscribe(
          port,
          ids.map((id) => ({
            id: qualifyAggregateId('run', id),
            fromSeq: 0,
          })),
        );
      };
      yield* Effect.acquireRelease(interest(source.current()), () =>
        source.subscribe(port, []),
      );
      const replayed = qualifyAggregateId('run', runId);
      return source.changes.pipe(
        // The level replays on subscribe, and the fold lands the
        // activation's row and the subscription's replay asynchronously,
        // so a replayed level can predate them: the run absent, its
        // transcript not yet read, or a resumed run with the outcome of
        // the activation before.
        Stream.dropWhile(
          (level) =>
            level.cursor < activation ||
            !level.runs.has(runId) ||
            !level.transcriptSeq.has(replayed),
        ),
        // The first level holding this activation's durable outcome, or
        // showing the run removed, is the last element.
        Stream.takeUntil((level) => {
          const run = level.runs.get(runId);
          return run === undefined || run.outcome != null;
        }),
        Stream.tap(interest),
      );
    }),
  );
}

/** The {@link Run} of `runId`'s activation at `activation` on `session`;
 *  `redirectedFrom`, the owned child a resume of it was asked for. */
export function runView(
  session: Context.Context<SessionServices>,
  runId: RunId,
  activation: CommitOrdinal,
  redirectedFrom?: RunId,
): Run {
  const log = Context.get(session, SessionLog);
  const view = Context.get(session, SessionViewAccess);
  const failure = (message: string, cause: unknown = new Error(message)) =>
    new RunFailure({ cause, message });
  // The activation is over once its end or the next activation commits, or
  // once nothing here holds the run any more: an end that did not save, a
  // session closing.
  const over = Effect.raceFirst(
    log.tail(activation).pipe(
      Stream.filter((row) => boundsLifecycle(row, runId)),
      Stream.runHead,
    ),
    Effect.suspend(
      () => Context.get(session, Runs).get(runId)?.drained ?? Effect.void,
    ),
  );
  // Read once the view applied it, so a view read afterwards includes it.
  const result = over.pipe(
    Effect.andThen(log.settled),
    Effect.andThen(() =>
      getRunRecords(runId).readRunEnd(activation).pipe(Effect.provide(session)),
    ),
    Effect.mapError((error) =>
      failure(`Run ${runId}'s end could not be read: ${error.message}`, error),
    ),
    Effect.flatMap((end) =>
      end === null
        ? Effect.fail(failure(`Run ${runId} ended without a stored end.`))
        : Effect.succeed(end),
    ),
  );
  return {
    runId,
    activation,
    ...(redirectedFrom !== undefined && { redirectedFrom }),
    result,
    view: activationView(
      {
        current: () => SubscriptionRef.getUnsafe(view.ref),
        changes: view.changes,
        subscribe: view.subscribe,
      },
      runId,
      activation,
    ),
    // Every reader replays this activation from the session's rows.
    events: replayTrace({ view, log }, runId, activation, result),
    interrupt: Context.get(session, SessionRequests)
      .request({ kind: 'run.stop', runId, reason: 'user' })
      .pipe(
        Effect.provide(session),
        Effect.ignore({ log: 'Warn', message: `Stopping run ${runId}` }),
      ),
  };
}
