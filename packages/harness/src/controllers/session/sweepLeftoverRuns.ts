import { Effect } from 'effect';
import { SessionRequests } from '@agent/runtime/requests';
import { cutShort } from '@agent/runtime/leftoverChildren';
import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';

const CHANNEL = 'LeftoverRunSweep';

/** The warning a failed step for `runId` leaves; the sweep goes on. */
const warning = (message: string, runId: RunId) => (error: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data: { runId, error } }),
    withLogChannel(CHANNEL),
  );

/**
 * The background shells of the cohort captured before session open that
 * ended on their own, removed: a shell is not resumable, and its end gave
 * its parent its result. One left running is its parent's to finish as it
 * resumes (`resumeLeftoverChildren`), and one a clean close stopped is
 * kept: its parent is told at its resume.
 */
export const sweepLeftoverRuns = Effect.gen(function* () {
  const requests = yield* SessionRequests;
  const log = yield* SessionLog;
  // The listing as the store holds it at open: a run launched since is
  // held here, which the closer leaves alone.
  const { runs } = yield* (yield* SessionViewAccess).read([]);
  for (const run of runs.values()) {
    if (run.identity.kind !== 'process' || run.outcome === null) continue;
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
