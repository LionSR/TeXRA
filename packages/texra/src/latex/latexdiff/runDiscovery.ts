import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * The run read latexdiff needs. Agent owns the implementation and hosts
 * inject it; latex owns the narrow contract so latexdiff never reaches into
 * `@agent/storage` itself.
 */
export interface LatexRunDiscoveryPort {
  /** One run's recorded output files by round, from the session's fold. */
  readRunOutputs(
    runId: RunId,
  ): Effect.Effect<ReadonlyRoundIndexed<OutputFileInfo>, Error>;
}
