import { Effect, Iterable } from 'effect';
import { SessionRequests } from '@agent/runtime/requests';
import { logFailure } from '@logger/effectLog';
import { SessionViewAccess } from '@shared/session/runHistory';

const CHANNEL = 'LeftoverRunSweep';

/**
 * The background shells of the cohort captured before session open that
 * ended, removed: a shell is not resumable, and its end gave its parent
 * its result. One left with no end is its parent's to finish as it
 * resumes (`resumeLeftoverChildren`).
 */
export const sweepLeftoverRuns = Effect.gen(function* () {
  const requests = yield* SessionRequests;
  // The listing as the store holds it at open: a run launched since is
  // held here, which the closer leaves alone.
  const { runs } = yield* (yield* SessionViewAccess).read([]);
  const finished = Iterable.filter(
    runs.values(),
    (run) => run.identity.kind === 'process' && run.outcome !== null,
  );
  yield* Effect.forEach(
    finished,
    (run) =>
      requests
        .request({ kind: 'run.delete', runId: run.id })
        .pipe(
          Effect.catch((error) =>
            logFailure(
              CHANNEL,
              'A background shell was retained because automatic deletion was refused.',
            )({ runId: run.id, error }),
          ),
        ),
    { discard: true },
  );
});
