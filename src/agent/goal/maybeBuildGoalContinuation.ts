import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { goalElapsedMs, type RunId } from '@shared/schemas';
import { goalOf, isGoalEnabled, type GoalReader } from '@tools/goal';
import { renderPrompt } from '@utils/prompt';
import { formatCompactDuration } from '@utils/text/stringUtils';

import { GOAL_CONTINUATION_TEMPLATE } from '../runtime/bundledPrompts';

/**
 * Build the pre-wait Goal continuation for a run in its session.
 *
 * Returns a rendered continuation prompt when:
 *   - the session's workspace has the feature flag on,
 *   - the run has a Goal with status `active`.
 *
 * Queue and subagent checks belong to the wait-node caller because it owns the
 * blocking wait. This helper is pure: no side effects, no counter, no audit
 * log. The autonomous loop runs until the model completes
 * (`plan(command="complete")` -> the goal is cleared) or the user stops it.
 *
 * Called from the tool-use loop BEFORE its follow-up wait — the
 * wait blocks indefinitely on an empty queue, so the continuation cannot run
 * after it.
 */
export async function maybeBuildGoalContinuation(
  session: GoalReader & Pick<SessionHandle, 'roots'>,
  runId: RunId,
): Promise<string | null> {
  const goal = goalOf(session, runId);
  if (goal?.status !== 'active') return null;

  if (!isGoalEnabled(session.roots.config)) return null;

  return renderPrompt(GOAL_CONTINUATION_TEMPLATE, {
    objective: goal.objective,
    timeUsed: formatCompactDuration(goalElapsedMs(goal)),
  });
}
