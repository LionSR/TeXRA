import { Clock, Effect } from 'effect';

import { goalElapsedMs, type RunId } from '@shared/schemas';
import { goalOf, type GoalReader } from '@tools/goal';
import { renderPrompt } from '@utils/prompt';
import { formatCompactDuration } from '@utils/text/stringUtils';

import { GOAL_CONTINUATION_TEMPLATE } from '../runtime/bundledPrompts';

/**
 * Build the pre-wait Goal continuation for a run in its session.
 *
 * Returns a rendered continuation prompt when the run has a Goal with status
 * `active`. Whether goal mode is on at all is the run's composition: only a
 * run whose plugins include `goal` asks.
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
export const maybeBuildGoalContinuation = Effect.fn('goal.continuation')(
  function* (
    session: GoalReader,
    runId: RunId,
  ): Effect.fn.Return<string | null, Error> {
    const goal = goalOf(session, runId);
    if (goal?.status !== 'active') return null;

    return yield* renderPrompt(GOAL_CONTINUATION_TEMPLATE, {
      objective: goal.objective,
      timeUsed: formatCompactDuration(
        goalElapsedMs(goal, yield* Clock.currentTimeMillis),
      ),
    });
  },
);
