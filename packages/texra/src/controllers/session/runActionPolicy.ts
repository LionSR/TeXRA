/**
 * Run actions every host takes the same way, as plain functions over the
 * `Session` the host holds: the GUI run actions and the CLI's commands and
 * slash commands call these rather than writing the request themselves.
 */
import { Effect } from 'effect';

import type { RequestError, Session } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/**
 * Fork `runId` into a new task holding its conversation up to `at` (its
 * latest finished point when absent): the new task's id, waiting for its
 * host to resume it. A refusal is the request's own error; any answer but
 * `forked` is a defect.
 */
export const forkRun = (
  session: Pick<Session, 'request'>,
  runId: RunId,
  at?: number | null,
): Effect.Effect<RunId, RequestError> =>
  session
    .request({ kind: 'run.fork', runId, at })
    .pipe(
      Effect.flatMap((outcome) =>
        outcome.kind === 'forked'
          ? Effect.succeed(outcome.runId)
          : Effect.die(new Error(`run.fork answered ${outcome.kind}`)),
      ),
    );
