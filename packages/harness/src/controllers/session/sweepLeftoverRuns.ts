import { Effect } from 'effect';
import { SessionRequests } from '@agent/runtime/requests';
import { closeLeftoverRun, cutShort } from '@agent/runtime/leftoverChildren';
import { withLogChannel } from '@logger/effectLog';
import { isLoopDriven, type RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';

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
 * is that parent's to finish as it resumes (`resumeLeftoverChildren`). A
 * background shell that ended on its own is removed: a shell is not
 * resumable, its end gave its parent its result, and a detached one's
 * report was there to read in the session that ended it. One a clean
 * close stopped is kept: its parent is told at its resume.
 */
export const sweepLeftoverRuns = Effect.gen(function* () {
  const requests = yield* SessionRequests;
  const log = yield* SessionLog;
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
    const facts = yield* log
      .facts(run.id)
      .pipe(
        Effect.catch(warning('A background shell could not be read.', run.id)),
      );
    if (facts == null || cutShort(facts)) continue;
    yield* requests
      .request({ kind: 'run.delete', runId: run.id })
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
