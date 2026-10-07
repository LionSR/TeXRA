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
 * - The run is a subagent in WAITING (job done, result already delivered
 *   by the child-run loop's per-turn delivery — see childRunLoop.ts).
 *
 * One handle lookup and one view read per call — no redundant lookups.
 */
export function shouldSkipWait(session: SessionHandle, runId: RunId): boolean {
  const handle = session.runs.getHandle(runId);
  if (!handle) return true;

  // A tracked run whose activation has not folded yet is running: the
  // handle exists because its process is live.
  const viewed = session.view.run(runId)?.status;
  const status =
    viewed === undefined || viewed === 'ready' ? RUN_PHASE.RUNNING : viewed;
  if (!isInFlightPhase(status)) return true;

  // A subagent in WAITING = job delivered by the child-run loop, don't block.
  // A top-level run in WAITING = human input needed, keep blocking.
  return (
    status === RUN_PHASE.WAITING &&
    handle.identity.kind === 'agent' &&
    handle.parent !== null
  );
}
