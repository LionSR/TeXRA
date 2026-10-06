/**
 * The documents plugin's read of a run's output files for the hosts'
 * latexdiff orchestration.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { documentsOf } from '@shared/plugins/documents';
import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';

/**
 * One run's recorded output files by round, from the session's fold: a
 * document task's documents. Hosts hand it to latexdiff orchestration, whose
 * run-discovery port it satisfies.
 */
export function runOutputReader(session: SessionHandle): {
  readonly readRunOutputs: (
    runId: RunId,
  ) => Effect.Effect<ReadonlyRoundIndexed<OutputFileInfo>, Error>;
} {
  return {
    readRunOutputs: (runId) =>
      session.view.read([runId]).pipe(
        Effect.map((view) => {
          const run = view.runs.get(runId);
          return run === undefined ? {} : documentsOf(run).files;
        }),
      ),
  };
}
