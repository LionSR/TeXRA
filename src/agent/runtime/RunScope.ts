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
  readonly runId: RunId;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  readonly session: SessionHandle;
  /**
   * Sticky cancellation state shared by every part of this run, for the
   * Promise-tier work a run still owns (the launch's session description, a
   * tool body that takes an `AbortSignal`). It is aborted *from* the run's
   * interruption, never the thing that stops the run: a stop completes the
   * launch context's stop latch, the run's program is interrupted, and the
   * bridge on that interruption aborts this signal.
   */
  readonly signal: AbortSignal;
}

export function createRunScope(scope: RunScope): RunScope {
  return Object.freeze({ ...scope });
}
