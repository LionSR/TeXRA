/**
 * Wait coordination for the executions tool's blocking `wait` action:
 * decides which executions are worth blocking on.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import { isInFlightPhase } from '@shared/runs/runStatus';
import type { SessionView } from '@shared/session/sessionView';

/**
 * Single-pass check: should the wait endpoint skip blocking on this run?
 *
 * Returns true when:
 * - No launch of it is in flight here (`LiveRun.launched`), OR
 * - The run left the canonical in-flight phases, OR
 * - The run is a subagent in WAITING (job done, result already delivered
 *   by the child-run loop's per-turn delivery — see childRunLoop.ts).
 *
 * One registry lookup per call; the status is read from `view`, the
 * snapshot the caller judges every run against.
 */
export function shouldSkipWait(
  session: SessionHandle,
  view: SessionView,
  runId: RunId,
): boolean {
  if (session.runs.get(runId)?.launched !== true) return true;

  // A launched run whose start has not folded yet is running.
  const run = view.runs.get(runId);
  const status =
    run === undefined || run.status === 'ready'
      ? RUN_PHASE.RUNNING
      : run.status;
  if (!isInFlightPhase(status)) return true;

  // A subagent in WAITING = job delivered by the child-run loop, don't block.
  // A top-level run in WAITING = human input needed, keep blocking.
  return (
    status === RUN_PHASE.WAITING &&
    run?.identity.kind === 'agent' &&
    run.parentId != null
  );
}
