/**
 * What a parked tool-use run does next when no one has asked it anything.
 *
 * The loop parks in `waiting` after every turn, a failed one included. Before
 * it blocks on the follow-up queue it asks the run's continuation policy once:
 * a `turn` opens a synthetic turn with that text, and null parks the run. A
 * follow-up that is already queued outranks the policy's turn; that choice is
 * the loop's, since the loop owns the queue, and the loop tells the policy
 * whether a turn could be taken at all so an unusable one is never built.
 *
 * The run resolves its policy once, when the loop is set up. Goal mode is the
 * one policy today.
 */
import { Effect } from 'effect';

import { maybeBuildGoalContinuation } from '@agent/goal/maybeBuildGoalContinuation';
import type { RunId } from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import { goalOf, pauseGoal, setGoalSessionAutoApproval } from '@tools/goal';

import type { SessionHandle } from '../SessionHandle';

interface ContinuationPolicy {
  /**
   * At idle: the next synthetic turn, or null to park. `canContinue` is
   * false when the run ends at this park or a follow-up is already queued.
   */
  readonly atIdle: (
    state: RunState,
    canContinue: boolean,
  ) => Effect.Effect<{ readonly turn: string } | null, Error>;
}

/**
 * Goal mode: an active goal opens the next turn itself. A failed turn pauses
 * the goal and revokes the goal's auto-approval instead, so the run parks for
 * the user. Goal state and its approval grants stay in `@tools/goal`; only the
 * decision lives here.
 */
export const goalContinuation = (
  session: SessionHandle,
  runId: RunId,
): ContinuationPolicy => ({
  atIdle: Effect.fn('goal.atIdle')(function* (
    state: RunState,
    canContinue: boolean,
  ) {
    if (state.lastError !== null) {
      if (goalOf(session, runId)?.status === 'active') {
        yield* pauseGoal(session, runId);
        setGoalSessionAutoApproval(session, runId, false);
      }
      return null;
    }
    if (!canContinue) return null;
    const text = yield* maybeBuildGoalContinuation(session, runId);
    return text === null ? null : { turn: text };
  }),
});
