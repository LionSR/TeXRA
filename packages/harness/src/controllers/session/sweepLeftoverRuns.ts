import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import type { RunView } from '@shared/session/sessionView';

const CHANNEL = 'LeftoverRunSweep';

/**
 * Remove the ended background shells of the cohort captured before session
 * open: a shell is not resumable, and its result reached its parent with
 * its end. One still running is a live process's, or a dead one's, which
 * its parent finishes as it resumes (`closeLeftoverChildren`).
 */
export const sweepLeftoverRuns = Effect.fn('sweepLeftoverRuns')(function* (
  session: SessionHandle,
  cohort: Iterable<RunView>,
) {
  for (const shell of cohort) {
    if (
      shell.identity.kind !== 'process' ||
      !isTerminalOutcomePhase(shell.status)
    )
      continue;
    yield* session.requests
      .removeRun(shell.id, 'automatic', shell.createdAt)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            'A background shell was retained because automatic deletion was refused.',
          ).pipe(
            Effect.annotateLogs({ data: { runId: shell.id, error } }),
            withLogChannel(CHANNEL),
          ),
        ),
      );
  }
});
