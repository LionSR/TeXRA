/**
 * The {@link Run} of `@texra-ai/harness`: one activation of a run, as a
 * view over its session's rows. It is `(session, runId, activation)`, the
 * activation's commit, and holds nothing: the run is its registry's, which
 * a launch or resume hands it to before this is built
 * (`sessionPrograms.ts`), so a reader that leaves, or a handle nobody reads,
 * changes nothing about the run.
 */
import { Effect, Stream } from 'effect';

import type { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import { getRunRecords } from '@agent/storage/runRecords';
import { replayTrace } from '@controllers/session/runTrace';
import type { CommitOrdinal, RunId } from '@shared/schemas';
import { runEndFromEvents } from '@shared/session/runFacts';

import { RunFailure } from './errors.js';
import type { Run } from './sessions.js';

/** The {@link Run} of `runId`'s activation at `activation` on `session`;
 *  `redirectedFrom`, the owned child a resume of it was asked for. */
export function runView(
  session: RuntimeSessionHandle,
  runId: RunId,
  activation: CommitOrdinal,
  redirectedFrom?: RunId,
): Run {
  const failure = (message: string, cause: unknown = new Error(message)) =>
    new RunFailure({ cause, message });
  // The activation is over once its end commits, or once nothing here holds
  // the run any more: an end that did not save, a session closing.
  const over = Effect.raceFirst(
    session.log.tail(activation).pipe(
      Stream.filter((row) => runEndFromEvents([row], runId) !== null),
      Stream.runHead,
    ),
    Effect.suspend(() => session.runs.get(runId)?.drained ?? Effect.void),
  );
  // Read once the view applied it, so a view read afterwards includes it.
  const result = over.pipe(
    Effect.andThen(session.log.settled),
    Effect.andThen(() => getRunRecords(session, runId).readRunEnd(activation)),
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
    ...(redirectedFrom !== undefined && { redirectedFrom }),
    result,
    view: session.view.changes.pipe(
      // The level replays on subscribe, and the fold lands the activation's
      // row asynchronously, so a replayed level can predate it: the run
      // absent, or a resumed run with the outcome of the activation before.
      Stream.dropWhile(
        (level) => level.cursor < activation || !level.runs.has(runId),
      ),
      // The first level holding this activation's durable outcome is the
      // last element.
      Stream.takeUntil(
        (level) => level.runs.get(runId)?.durableOutcome != null,
      ),
    ),
    // Every reader replays this activation from the session's rows.
    events: replayTrace(session, runId, activation, result),
    interrupt: session.requests
      .request({ kind: 'run.stop', runId, reason: 'user' })
      .pipe(Effect.ignore({ log: 'Warn', message: `Stopping run ${runId}` })),
  };
}
