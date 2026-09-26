/**
 * Wait coordination for the executions tool's blocking `wait` action:
 * decides which executions are worth blocking on.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';

/**
 * Single-pass check: should the wait endpoint skip blocking on this run?
 *
 * Returns true when:
 * - The handle is gone (run already untracked / completed), OR
 * - The run left the canonical in-flight phases, OR
 * - The run is a *tool-use subagent* in WAITING (job done, result
 *   already delivered by the child-run loop's per-turn delivery — see
 *   childRunLoop.ts). Workflow subagents in WAITING may still be awaiting
 *   retry/user action and should keep blocking.
 *
 * One handle lookup and one view read per call — no redundant lookups.
 */
export function shouldSkipWait(session: SessionHandle, runId: RunId): boolean {
  const handle = session.runs.getHandle(runId);
  if (!handle) return true;

  // A tracked run whose activation has not folded yet is running: the
  // handle exists because its process is live.
  const viewed = session.runView(runId)?.status;
  const status =
    viewed === undefined || viewed === 'ready' ? RUN_PHASE.RUNNING : viewed;
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
    handle.parent !== null
  );
}
