import type { ExecutionId, StreamTabId } from '@shared/schemas';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

/**
 * Canonical identity and ownership scope for a launched agent run.
 *
 * This object is deliberately smaller than `AgentLaunchContext`: it contains
 * only the facts that identify the run and the session that owns its runtime
 * state. Older flat fields remain on launch contexts for compatibility, but
 * new runtime code should prefer carrying this object when it needs the full
 * run scope.
 */
export interface RunScope {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName: string;
  readonly workingDirectory?: string;
  readonly session: SessionHandle;
}

export function createRunScope(scope: RunScope): RunScope {
  return Object.freeze({ ...scope });
}
