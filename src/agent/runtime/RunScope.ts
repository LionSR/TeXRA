import type { AgentDelegationScope, RunId } from '@shared/schemas';

import type { SessionHandle } from './SessionHandle';

/**
 * Canonical identity and ownership scope for a launched agent run.
 *
 * `AgentLaunchContext` and the ambient `RunContext` both carry this object
 * whenever they need the run's id or the session that owns runtime state.
 * The run's name is not here: it is `runIdentityName(handle.identity)`, read
 * off the run's handle, so the model node and the delegation tools cannot
 * read two different fields for it.
 */
export interface RunScope {
  readonly executionId: RunId;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  readonly session: SessionHandle;
  /** Sticky cancellation state shared by every part of this run. */
  readonly signal: AbortSignal;
}

export function createRunScope(scope: RunScope): RunScope {
  return Object.freeze({ ...scope });
}
