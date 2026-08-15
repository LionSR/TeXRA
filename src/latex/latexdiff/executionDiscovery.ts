import type { ExecutionId, StreamTabId } from '@shared/schemas';

/**
 * The agent-run listing slice latexdiff discovery needs. Agent owns the
 * implementation and hosts inject it; latex owns the narrow contract so
 * `outputDiscovery.ts` never reaches into `@agent/storage` itself.
 */
export interface LatexAgentRunEntry {
  readonly id: ExecutionId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly inputFiles: readonly string[];
}

export interface LatexExecutionDiscoveryPort {
  listAgentRuns(): Promise<readonly LatexAgentRunEntry[]>;
  readStreamId(executionId: ExecutionId): Promise<StreamTabId | undefined>;
}
