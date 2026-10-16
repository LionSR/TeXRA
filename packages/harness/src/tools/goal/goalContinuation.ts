/**
 * Goal mode's continuation: while the run's goal is active, a parked
 * conversation opens its next turn itself. A failed turn, or a resume, pauses
 * the goal (its own row) and revokes its auto-approval instead; only a human
 * re-arms it (approving a plan), and a goal armed after the resume stays
 * armed. An active goal also pauses, with a warning on the transcript, once
 * the run tree's spend reaches `texra.goal.maxCostUsd`, read at each idle.
 */
import { Clock, Effect, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { goalElapsedMs } from '@shared/plugins/goal';
import { GOAL_MAX_COST_SETTING, type RunId } from '@shared/schemas';
import type { Continuation } from '@tools/toolTable';
import { readSettingFrom } from '@utils/config/platformSettings';
import { renderPrompt } from '@utils/prompt';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

import { goalOf, pauseGoal } from './goalRows';

/**
 * The goal continuation injected at the end of an idle turn while a goal is
 * active.
 */
const GOAL_CONTINUATION_TEMPLATE =
  [
    '<goal_context>',
    'Autonomous objective active. Keep working until it is verifiably done.',
    'Do not end your turn to summarize progress or hand back control; only',
    "stop when the objective's end state is true and you have inspected real",
    'evidence for it. Persist even when a tool call or command fails:',
    'diagnose, adjust, and retry rather than yielding.',
    '',
    '<objective>',
    '{{objective}}',
    '</objective>',
    '',
    'Time elapsed: {{timeUsed}}',
    '',
    '- Do not redefine success around a smaller or easier task, and do not',
    '  substitute a narrower, safer, or merely test-passing solution for the',
    '  behavior the objective requests.',
    '- If you cannot finish this turn, make concrete progress and keep going.',
    '- Treat completion as unproven until you have inspected authoritative',
    '  evidence (file contents, command output, test results, runtime',
    "  behavior) for every requirement. Match the check's scope to the",
    "  requirement's scope, and gather stronger evidence when it is weak or",
    '  indirect.',
    '</goal_context>',
  ].join('\n') + '\n';

const pauseActive = Effect.fn('goal.pause')(function* ({
  session,
  runId,
}: {
  readonly session: SessionHandle;
  readonly runId: RunId;
}) {
  if (goalOf(session, runId)?.status !== 'active') return;
  yield* pauseGoal(session, runId);
});

export const goalContinuation: Continuation = {
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
    const cap = yield* readSettingFrom<number>(
      session.roots,
      GOAL_MAX_COST_SETTING.configKey,
    );
    const spent =
      (yield* SubscriptionRef.get(session.view.ref)).runs.get(runId)?.treeUsage
        .cost ?? 0;
    if (cap > 0 && spent >= cap) {
      yield* pauseActive({ session, runId });
      session.log.publish(runId, {
        type: 'log',
        level: 'warn',
        message:
          `Goal paused: this run and its subagents have spent ${formatCostUsd(spent)}, ` +
          `reaching the ${formatCostUsd(cap)} goal cap. Raise ${GOAL_MAX_COST_SETTING.configKey} ` +
          `(0 removes it), then re-arm the goal.`,
      });
      return null;
    }
    return yield* renderPrompt(GOAL_CONTINUATION_TEMPLATE, {
      objective: goal.objective,
      timeUsed: formatCompactDuration(
        goalElapsedMs(goal, yield* Clock.currentTimeMillis),
      ),
    });
  }),
  onResume: pauseActive,
};
