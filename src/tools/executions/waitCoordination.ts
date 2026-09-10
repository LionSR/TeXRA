/**
 * Wait-coordination helpers for the executions tool's blocking `wait` action.
 * Decides which executions are worth blocking on and lets a follow-up message
 * break a blocking wait early.
 */

import {
  getRunContextRunId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { currentSession } from '@agent/runtime/SessionHandle';
import { RUN_PHASE } from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

/**
 * Single-pass check: should the wait endpoint skip blocking on this run?
 *
 * Returns true when:
 * - The handle is gone (run already untracked / completed), OR
 * - The stream left the canonical in-flight phases, OR
 * - The run is a *tool-use subagent* in WAITING (job done, result
 *   already delivered by the child-run loop's per-turn delivery — see
 *   childRunLoop.ts). Workflow subagents in WAITING may still be awaiting
 *   retry/user action and should keep blocking.
 *
 * One getHandle + one getStatus per call — no redundant lookups.
 */
export function shouldSkipWait(runId: string): boolean {
  const session = currentSession();
  const handle = session.runs.getHandle(runId);
  if (!handle) return true;

  const { status } = session.runs.getStatus(handle);
  if (!isInFlightPhase(status)) return true;

  // Tool-use subagent in WAITING = job delivered by the child-run loop, don't block.
  // Workflow subagent in WAITING = may be waiting for retry/user action. Blocking
  // isn't very useful (only the user can unblock it), but the subagent is still
  // technically active so we don't skip — avoids misreporting it as done.
  // Non-subagent WAITING = human input needed, keep blocking.
  return (
    status === RUN_PHASE.WAITING &&
    handle.identity.kind === 'agent' &&
    handle.category === 'toolUse' &&
    handle.isChild
  );
}

/**
 * Listen for follow-up messages on the current stream and call `onFollowUp`
 * when one arrives. This lets users break out of a blocking
 * `executions wait` by sending a follow-up message.
 *
 * Observes the owning session's follow-up queue (`ToolUseFollowUpQueue.onSent`,
 * what `notifyFollowUpSent` fires), so follow-up delivery has exactly one
 * in-process channel and no plane row.
 *
 * Returns a cleanup function that removes the listener.
 */
export function listenForFollowUp(onFollowUp: () => void): () => void {
  const context = tryUseRunContext();
  const runId = getRunContextRunId(context);
  if (!runId) return () => {};

  return currentSession().followUps.onSent((sentRunId) => {
    if (sentRunId === runId) onFollowUp();
  });
}
