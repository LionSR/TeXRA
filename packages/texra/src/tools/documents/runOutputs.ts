/**
 * The documents plugin's read of a run's output files for the hosts'
 * latexdiff orchestration.
 */
import { Effect } from 'effect';

import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { documentsOf } from '@texra/shared/plugins/documents';

/**
 * One run's recorded output files by round, from the session's fold: a
 * document task's documents. Hosts hand it to latexdiff orchestration, whose
 * run-discovery port it satisfies.
 */
export function runOutputReader(session: {
  readonly view: {
    readonly read: (runIds: readonly RunId[]) => Effect.Effect<SessionView>;
  };
}): {
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
