/**
 * What resuming and forking a run answer, for every host: the GUI windows'
 * run actions and the terminal chat's `/resume`, `/resume all` and `/fork`
 * read the session's answers through these, so a refusal is worded and
 * mapped once.
 */
import { Effect } from 'effect';

import {
  isRequestRefusal,
  Unavailable,
  type RequestRefusal,
  type Run,
  type RunFailure,
  type Session,
} from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/**
 * Resume `runId` on `session`: the run that continues (the one asked for,
 * or the parent that owns it), `'waiting'` when it waits for what blocks it
 * (its agent, a plugin) and continues once that is back, or the refusal
 * that says why it does not continue. A run that fails to start is a
 * `RunFailure`, not a refusal.
 */
export const resumeRun = (
  session: Session,
  runId: RunId,
): Effect.Effect<Run | 'waiting', RequestRefusal | RunFailure> =>
  session.resume(runId, { interactive: true }).pipe(
    Effect.catchTags({
      ResumeRefused: (refusal) =>
        refusal.reason === 'blocked'
          ? Effect.succeed('waiting' as const)
          : Effect.fail(new Unavailable({ runId, reason: refusal.message })),
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
    Effect.flatMap((outcome) =>
      outcome.kind === 'forked'
        ? Effect.succeed(outcome.runId)
        : Effect.die(new Error(`run.fork answered ${outcome.kind}`)),
    ),
  );
