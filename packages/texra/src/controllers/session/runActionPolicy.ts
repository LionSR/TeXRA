/**
 * What resuming and forking a run answer, for every host: the GUI windows'
 * run actions and the terminal chat's `/resume`, `/resume all` and `/fork`
 * read the session's answers through these, so a refusal is worded and
 * mapped once.
 */
import { Effect } from 'effect';

import {
  type LaunchRefused,
  type Run,
  type RunFailure,
  type Session,
} from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';
import { Unavailable } from '@texra-ai/harness/schemas';
import {
  isRequestRefusal,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';

/**
 * Resume `runId` on `session`: the run that continues (the one asked for,
 * or the parent that owns it), or the refusal that says why it does not
 * continue, a missing agent or plugin included. A launch refused with a
 * notice to show (an unknown model) is a `LaunchRefused`, and a run that
 * fails to start a `RunFailure`; neither is a request refusal.
 */
export const resumeRun = (
  session: Session,
  runId: RunId,
): Effect.Effect<Run, RequestRefusal | LaunchRefused | RunFailure> =>
  session.resume(runId, { interactive: true }).pipe(
    Effect.catchTags({
      ResumeRefused: (refusal) =>
        Effect.fail(new Unavailable({ runId, reason: refusal.message })),
      ToolsRefused: (refusal) =>
        Effect.fail(new Unavailable({ runId, reason: refusal.message })),
    }),
  );

/** A new task holding `runId`'s conversation up to `at` (its latest settled
 *  point when null): the fork's id, or the refusal that says why not. */
export const forkRun = (
  session: Session,
  runId: RunId,
  at: number | null,
): Effect.Effect<RunId, RequestRefusal> =>
  session.request({ kind: 'run.fork', runId, at }).pipe(
    Effect.mapError((error): RequestRefusal =>
      isRequestRefusal(error)
        ? error
        : new Unavailable({ runId, reason: 'The task could not be forked.' }),
    ),
    Effect.map((outcome) => outcome.runId),
  );
