import type { StreamTabId } from '@shared/schemas';
import { formatGoalTime, goalElapsedMs } from '@shared/schemas';
import { GoalStore, isGoalEnabled } from '@tools/goal';
import { renderPrompt } from '@utils/prompt';

import { getContinuationTemplate } from './promptLoader';

/**
 * Build the pre-wait Goal continuation for a stream.
 *
 * Returns a rendered continuation prompt when:
 *   - the feature flag is on,
 *   - the stream has a Goal with status `active`.
 *
 * Queue and subagent checks belong to the wait-node caller because it owns the
 * blocking wait. This helper is pure: no side effects, no counter, no audit
 * log. The autonomous loop runs until the model completes
 * (`plan(command="complete")` → forget) or the user stops it.
 *
 * Called from `ToolUseWaitNode.exec()` BEFORE `session.waitForFollowUp` — the
 * wait blocks indefinitely on an empty queue, so the continuation cannot run
 * after it.
 */
export async function maybeBuildGoalContinuation(
  streamId: StreamTabId,
): Promise<string | null> {
  // Read the store first — it is bootstrap-tolerant (returns null before
  // platform init), so the flag check below (which needs `platform()`) is only
  // reached when an active record actually exists on disk.
  const goal = GoalStore.getForStream(streamId);
  if (!goal || goal.status !== 'active') return null;

  if (!isGoalEnabled()) return null;

  const template = await getContinuationTemplate();
  return renderPrompt(template, {
    objective: goal.objective,
    timeUsed: formatGoalTime(goalElapsedMs(goal)),
  });
}
