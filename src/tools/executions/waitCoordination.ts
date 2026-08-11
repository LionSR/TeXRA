/**
 * Wait-coordination helpers for the executions tool's blocking `wait` action.
 * Decides which executions are worth blocking on and lets a follow-up message
 * break a blocking wait early.
 */

import {
  getRunContextSession,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { currentSession } from '@agent/runtime/SessionHandle';
import { STREAM_PHASE } from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

/**
 * Single-pass check: should the wait endpoint skip blocking on this execution?
 *
 * Returns true when:
 * - The handle is gone (execution already untracked / completed), OR
 * - The stream left the canonical in-flight phases, OR
 * - The execution is a *tool-use subagent* in WAITING (job done, result
 *   already delivered by the child-run loop's per-turn delivery — see
 *   childRunLoop.ts). Workflow subagents in WAITING may still be awaiting
 *   retry/user action and should keep blocking.
 *
 * One getHandle + one getStatus per call — no redundant lookups.
 */
export function shouldSkipWait(executionId: string): boolean {
  const session = currentSession();
  const handle = session.executions.getHandle(executionId);
  if (!handle) return true;

  const { status } = session.executions.getStatus(handle);
  if (!isInFlightPhase(status)) return true;

  // Tool-use subagent in WAITING = job delivered by the child-run loop, don't block.
  // Workflow subagent in WAITING = may be waiting for retry/user action. Blocking
  // isn't very useful (only the user can unblock it), but the subagent is still
  // technically active so we don't skip — avoids misreporting it as done.
  // Non-subagent WAITING = human input needed, keep blocking.
  return (
    status === STREAM_PHASE.WAITING &&
    handle instanceof AgentExecutionHandle &&
    handle.identity.kind === 'agent' &&
    handle.category === 'toolUse' &&
    handle.isChildExecution
  );
}

/**
 * Listen for follow-up messages on the current stream and abort the given
 * AbortController when one arrives. This lets users break out of a blocking
 * `executions wait` by sending a follow-up message.
 *
 * Subscribes to the owning session's `followUpSent` fact — the same hub
 * `notifyFollowUpSent` publishes on — so follow-up delivery has exactly one
 * emission channel.
 *
 * Returns a cleanup function that removes the listener.
 */
export function listenForFollowUp(ac: AbortController): () => void {
  const context = tryUseRunContext();
  const streamId = getRunContextStreamId(context);
  if (!streamId) return () => {};

  const session = getRunContextSession(context) ?? currentSession();
  return session.events.subscribeSessionFacts((fact) => {
    if (fact.type === 'followUpSent' && fact.payload.streamId === streamId) {
      ac.abort();
    }
  });
}
