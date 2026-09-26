/**
 * Wait coordination for the executions tool's blocking `wait` action:
 * decides which executions are worth blocking on.
 */

import type { RunRegistry } from '@agent/runtime/runRegistry';
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
 * One getHandle + one getStatus per call — no redundant lookups.
 */
export function shouldSkipWait(runs: RunRegistry, runId: RunId): boolean {
  const handle = runs.getHandle(runId);
  if (!handle) return true;

  const { status } = runs.getStatus(handle);
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
