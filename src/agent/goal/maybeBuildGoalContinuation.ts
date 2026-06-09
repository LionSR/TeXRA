import type { StreamTabId } from '@shared/schemas/identifiers';

import { GoalStore, isGoalEnabled } from '@tools/goal';

import { buildContinuationFollowUp } from './buildContinuationFollowUp';

export interface GoalContinuationContext {
  streamId: StreamTabId;
  /** True when the current wait-node is running inside an orchestrator-driven subagent. */
  isSubagent: boolean;
  /** Result of `session.hasQueuedFollowUp()` at the call site. */
  hasQueuedFollowUp: boolean;
}

/**
 * Pre-wait Goal continuation check.
 *
 * Returns a rendered continuation prompt when:
 *   - the feature flag is on,
 *   - the current node is NOT a subagent (parent orchestrator owns continuation
 *     — subagents only ever roll their usage up to the parent, never drive the
 *     loop),
 *   - no user followUp is already queued (caller-supplied snapshot),
 *   - the stream has a Goal with status `active`.
 *
 * Returns null in every other case so the caller falls back to the normal
 * blocking wait. Pure: no side effects. The autonomous loop runs until the
 * model finishes (`plan(command="complete")` → forget) or the user stops it;
 * there is no continuation counter or per-turn cap.
 *
 * Called from `ToolUseWaitNode.exec()` BEFORE `session.waitForFollowUp` — the
 * wait blocks indefinitely on an empty queue, so the continuation cannot run
 * after it.
 */
export async function maybeBuildGoalContinuation(
  ctx: GoalContinuationContext,
): Promise<string | null> {
  if (ctx.isSubagent) return null;
  if (ctx.hasQueuedFollowUp) return null;

  // Read the store first — it is bootstrap-tolerant (returns null before
  // platform init), so the flag check below (which needs `platform()`) is only
  // reached when an active record actually exists on disk.
  const goal = GoalStore.getForStream(ctx.streamId);
  if (!goal || goal.status !== 'active') return null;

  if (!isGoalEnabled()) return null;

  return buildContinuationFollowUp(goal);
}
