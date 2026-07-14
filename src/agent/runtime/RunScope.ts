import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { AgentDelegationScope } from '@shared/schemas/agentRoster';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

/**
 * Canonical identity and ownership scope for a launched agent run.
 *
 * `AgentLaunchContext` and the ambient `RunContext` both carry this object
 * (not flat `streamId`/`executionId`/`agentName` fields) whenever they need
 * run identity or the session that owns runtime state.
 */
export interface RunScope {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName: string;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  readonly session: SessionHandle;
}

export function createRunScope(scope: RunScope): RunScope {
  return Object.freeze({ ...scope });
}
