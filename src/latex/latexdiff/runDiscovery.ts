import type {
  OutputFileInfo,
  ReadonlyRoundIndexed,
  RunId,
} from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * The agent-run listing slice latexdiff discovery needs. Agent owns the
 * implementation and hosts inject it; latex owns the narrow contract so
 * `outputDiscovery.ts` never reaches into `@agent/storage` itself.
 */
interface LatexAgentRunEntry {
  readonly id: RunId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly inputFiles: readonly string[];
}

export interface LatexRunDiscoveryPort {
  listAgentRuns(): Effect.Effect<readonly LatexAgentRunEntry[], Error>;
  /** One run's recorded output files by round, from the session's fold. */
  readRunOutputs(
    runId: RunId,
  ): Effect.Effect<ReadonlyRoundIndexed<OutputFileInfo>, Error>;
}
