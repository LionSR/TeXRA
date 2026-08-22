import type {
  AgentDelegationScope,
  ExecutionId,
  StreamTabId,
} from '@shared/schemas';

import type { SessionHandle } from './SessionHandle';

/**
 * Canonical identity and ownership scope for a launched agent run.
 *
 * `AgentLaunchContext` and the ambient `RunContext` both carry this object
 * (not flat `streamId`/`executionId`/`agentName` fields) whenever they need
 * run identity or the session that owns runtime state.
 */
export interface RunScope {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  /** Launch identifier, retained for display and compatibility. */
  readonly agentName: string;
  /** Canonical `source:name` identity resolved for this launch. */
  readonly agentKey?: string;
  /** Immutable execution lineage; true when this run was delegated. */
  readonly isSubagent?: boolean;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  readonly session: SessionHandle;
  /** Sticky cancellation state shared by every part of this run. */
  readonly signal: AbortSignal;
}

export function createRunScope(scope: RunScope): RunScope {
  return Object.freeze({ ...scope });
}
