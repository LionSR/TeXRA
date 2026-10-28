import { Effect, SubscriptionRef } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { RUN_SUBSTATE, type RunId } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';

const CHANNEL = 'LeftoverRunSweep';

/** Runs still going: held by this process, or listed by the view as
 *  running or waiting (a run whose owner process died is listed as
 *  interrupted, so it is swept). */
function runningRuns(session: SessionHandle): Set<RunId> {
  const running = new Set(session.runs.get().map((run) => run.runId));
  for (const run of SubscriptionRef.getUnsafe(session.view.ref).runs.values()) {
    if (run.group === 'running' || run.group === 'waiting') running.add(run.id);
  }
  return running;
}

/** Remove the nonresumable background-shell cohort captured before session open. */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(function* (
  session: SessionHandle,
  cohort: Iterable<RunView>,
) {
  const running = runningRuns(session);
  for (const { id: runId, identity, substate, createdAt } of cohort) {
    // A shell parked holding its result for its parent stays until that
    // result is delivered.
    if (
      identity.kind !== 'process' ||
      substate === RUN_SUBSTATE.RESULT_WAITING ||
      running.has(runId)
    )
      continue;
    yield* session.requests
      .removeRun(runId, 'automatic', createdAt)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            'A background shell was retained because automatic deletion was refused.',
          ).pipe(
            Effect.annotateLogs({ data: { runId, error } }),
            withLogChannel(CHANNEL),
          ),
        ),
      );
  }
});
