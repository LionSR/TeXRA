/**
 * Goal mode's continuation: while the run's goal is active, a parked
 * conversation opens its next turn itself. A failed turn, or a resume, pauses
 * the goal (its own row) and revokes its auto-approval instead; only a human
 * re-arms it (approving a plan), and a goal armed after the resume stays
 * armed.
 */
import { Clock, Effect } from 'effect';

import { GOAL_CONTINUATION_TEMPLATE } from '@agent/runtime/bundledPrompts';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { AgentCategory, goalElapsedMs, type RunId } from '@shared/schemas';
import type { Continuation } from '@tools/toolTable';
import { renderPrompt } from '@utils/prompt';
import { formatCompactDuration } from '@utils/text/stringUtils';

import { setGoalSessionAutoApproval } from './goalAutoApproval';
import { goalOf, pauseGoal } from './goalRows';

const pauseActive = Effect.fn('goal.pause')(function* ({
  session,
  runId,
}: {
  readonly session: SessionHandle;
  readonly runId: RunId;
}) {
  if (goalOf(session, runId)?.status !== 'active') return;
  yield* pauseGoal(session, runId);
  setGoalSessionAutoApproval(session, runId, false);
});

export const goalContinuation: Continuation = {
  category: AgentCategory.ToolUse,
  atIdle: Effect.fn('goal.atIdle')(function* ({
    session,
    runId,
    state,
    canContinue,
  }) {
    const goal = goalOf(session, runId);
    if (goal?.status !== 'active') return null;
    if (state.lastError !== null) {
      yield* pauseActive({ session, runId });
      return null;
    }
    if (!canContinue) return null;
    return yield* renderPrompt(GOAL_CONTINUATION_TEMPLATE, {
      objective: goal.objective,
      timeUsed: formatCompactDuration(
        goalElapsedMs(goal, yield* Clock.currentTimeMillis),
      ),
    });
  }),
  onResume: pauseActive,
};
