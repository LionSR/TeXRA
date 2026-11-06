import { Effect } from 'effect';
import { SessionRequests } from '@agent/runtime/requests';
import { closeLeftoverRun } from '@agent/runtime/leftoverChildren';
import { withLogChannel } from '@logger/effectLog';
import { isLoopDriven, type RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { SessionViewAccess } from '@shared/session/runHistory';

const CHANNEL = 'LeftoverRunSweep';

/** The warning a failed step for `runId` leaves; the sweep goes on. */
const warning = (message: string, runId: RunId) => (error: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data: { runId, error } }),
    withLogChannel(CHANNEL),
  );

/**
 * The process runs (background shells, agent CLIs) of the cohort captured
 * before session open that no resume will finish. One left running with no
 * parent, a detach having let it go, is closed as interrupted
 * ({@link closeLeftoverRun}); one with a parent
 * is that parent's to finish as it resumes (`resumeLeftoverChildren`). An
 * ended background shell is removed: a shell is not resumable, its end gave
 * its parent its result, and a detached one's report was there to read in
 * the session that ended it.
 */
export const sweepLeftoverRuns = Effect.gen(function* () {
  const requests = yield* SessionRequests;
  // The listing as the store holds it at open: a run launched since is
  // held here, which the closer leaves alone.
  const { runs } = yield* (yield* SessionViewAccess).read([]);
  for (const run of runs.values()) {
    if (isLoopDriven(run.identity)) continue;
    if (!isTerminalOutcomePhase(run.status)) {
      if (run.parentId === null)
        yield* closeLeftoverRun(null, run).pipe(
          Effect.catch(
            warning('A detached process run was left unclosed.', run.id),
          ),
        );
      continue;
    }
    if (run.identity.kind !== 'process') continue;
    yield* requests
      .removeRun(run.id, run.createdAt)
      .pipe(
        Effect.catch(
          warning(
            'A background shell was retained because automatic deletion was refused.',
            run.id,
          ),
        ),
      );
  }
});
