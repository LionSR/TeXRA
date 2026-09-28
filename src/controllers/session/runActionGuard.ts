/**
 * What a host's run actions check as each request is handled, not only as it
 * was rendered: the run's current `actions`, whether this process is already
 * resuming it, and, for an action that reads or changes its files, a hold on
 * the stopped run that takes its claim, so another process sees it held.
 */
import { Effect, type Scope } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunAction, RunId } from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';
import { runActionRefusal } from '@shared/session/runActions';
import { toErrorMessage } from '@utils/errors/errorMessage';

export function runActionGuard(
  session: Pick<SessionHandle, 'runView' | 'runs'>,
) {
  /** Runs this process is resuming: a second Resume, and a pack, clean,
   *  diff or restore, is refused while one is in flight, never queued
   *  behind a whole run. Across processes the run's claim answers. */
  const resuming = new Set<RunId>();
  const busy = () => new Rejected({ reason: 'This run is already resuming.' });
  const idle = (runId: RunId): Effect.Effect<void, Rejected> =>
    resuming.has(runId) ? Effect.fail(busy()) : Effect.void;
  return {
    idle,
    /** The run's `actions` must still hold `action`; a run the view no
     *  longer holds is left to the action's own read. */
    require: (runId: RunId, action: RunAction): Effect.Effect<void, Rejected> =>
      Effect.suspend(() => {
        const run = session.runView(runId);
        return run === undefined || run.actions.includes(action)
          ? Effect.void
          : Effect.fail(
              new Rejected({ reason: runActionRefusal(run, action) }),
            );
      }),
    /** Hold a stopped run for the caller's scope: the registry's inactive
     *  hold takes the run's claim and refuses a run live in this process,
     *  and a resume that starts meanwhile is refused by the hold. */
    hold: (runId: RunId): Effect.Effect<void, Rejected, Scope.Scope> =>
      idle(runId).pipe(
        Effect.andThen(session.runs.holdInactiveRun(runId)),
        Effect.mapError((cause) =>
          cause instanceof Rejected
            ? cause
            : new Rejected({
                reason: `This run is running or held elsewhere: ${toErrorMessage(cause)}`,
              }),
        ),
      ),
    /** Run `resume` marked as resuming: checked and marked in one
     *  synchronous step, cleared however it ends. */
    resuming: <A, E, R>(
      resume: Effect.Effect<A, E, R>,
      runId: RunId,
    ): Effect.Effect<A, E | Rejected, R> =>
      Effect.suspend((): Effect.Effect<A, E | Rejected, R> => {
        if (resuming.has(runId)) return Effect.fail(busy());
        resuming.add(runId);
        return resume.pipe(
          Effect.ensuring(Effect.sync(() => resuming.delete(runId))),
        );
      }),
  };
}
