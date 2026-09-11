import type { RunId } from '@shared/schemas';
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
}
