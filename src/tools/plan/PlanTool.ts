/**
 * Unified plan + goal tool.
 *
 * `command: 'update'` proposes or replaces the plan: a plain objective
 * document stating what to achieve, the approach, and a verifiable
 * stopping condition. Every update gates on user approval; the user may
 * approve, approve and start an autonomous goal, or reject. Step tracking
 * belongs to the todo tool — the plan has no structured steps.
 *
 * `command: 'pause'` and `command: 'complete'` drive the lifecycle of the
 * goal pursuing this plan: pause when user input is needed, complete when
 * the objective is verifiably done. When no autonomous goal is in flight,
 * they return plain guidance for ordinary turn-by-turn chat.
 */

// Third-party imports
import { Clock, Effect } from 'effect';
import { z } from 'zod';

// Local imports
import type { WorkPlanState } from '@agent/core/state/AgentWorkspaceState';
import { ToolCall } from '@agent/runtime/ToolCall';
import { withLogChannel } from '@logger/effectLog';
import { goalElapsedMs, type Goal } from '@shared/plugins/goal';
import type { Plan, RunId, ToolResult } from '@shared/schemas';
import { ToolError } from '@shared/schemas';
import { refusalOf } from '@shared/session/approvalDecision';
import {
  clearGoal,
  goalOf,
  pauseGoal,
  retargetGoal,
  setGoalSessionAutoApproval,
  startGoal,
  type GoalAutoApprovalScope,
} from '@tools/goal';
import { requireNonEmptyString } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { errorResult, executed } from '@tools/core/result';
import type { RunToolCall } from '@tools/core/toolRun';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatCompactDuration } from '@utils/text/stringUtils';

const CHANNEL = 'PlanTool';

function formatGoalView(goal: Goal, nowMs: number): string {
  return [
    `Goal: ${goal.goalId}`,
    `Status: ${goal.status}`,
    `Time elapsed: ${formatCompactDuration(goalElapsedMs(goal, nowMs))}`,
  ].join('\n');
}

/**
 * Schema for the unified plan tool input. A discriminated union over
 * `command`: 'update' carries the plan; 'pause'/'complete' carry a reason.
 * Branches stay `looseObject`: provider schema flattening advertises one
 * object across commands, and OpenAI-compatible providers null-fill the other
 * branches' fields.
 */
const PlanToolInputSchema = z.discriminatedUnion('command', [
  z.looseObject({
    command: z.literal('update'),
    objective: z
      .string()
      .min(1)
      .describe(
        'The plan document: what to achieve, the intended approach, and a ' +
          'verifiable stopping condition. Plain prose or markdown - no ' +
          'structured steps (track those with the todo tool).',
      ),
  }),
  z.looseObject({
    command: z.literal('pause'),
    reason: z
      .string()
      .min(1)
      .describe('Why you are pausing: describe what you need from the user.'),
  }),
  z.looseObject({
    command: z.literal('complete'),
    reason: z
      .string()
      .min(1)
      .describe(
        'How you verified completion: cite current filesystem state, ' +
          'test output, or command results (never conversation memory).',
      ),
  }),
]);

type PlanToolInput = z.infer<typeof PlanToolInputSchema>;

function buildApprovedResult(): ToolResult {
  return executed(
    'Plan approved by the user. Work toward the objective, tracking concrete steps with the todo tool.',
    'Plan approved: proceed with implementation',
  );
}

/**
 * Start an autonomous goal whose objective is the just-approved plan
 * document, verbatim. If one is already in flight for the run, retarget it
 * so future continuations follow the current user decision.
 */
const startGoalForPlan = Effect.fn('PlanTool.startGoalForPlan')(function* (
  call: RunToolCall,
  plan: Plan,
  runId: RunId,
  autoApprovalScope: GoalAutoApprovalScope,
) {
  const objective = plan.objective;

  // If a goal is already in flight on this run, retarget it at the
  // newly approved objective instead of silently leaving the loop driving
  // the stale one.
  if (goalOf(call.run.session, runId)) {
    return yield* Effect.gen(function* () {
      const active = yield* retargetGoal(call.run.session, runId, objective);
      setGoalSessionAutoApproval(call.run.session, runId, autoApprovalScope);
      return executed(
        `The user approved a new plan while goal ${active.goalId} ` +
          `was already in flight. The goal has been retargeted to the ` +
          `new objective.\n\n` +
          `${formatGoalView(active, yield* Clock.currentTimeMillis)}\n\n` +
          `Discipline:\n` +
          `- Drop work that only served the previous objective.\n` +
          `- Track concrete steps with the todo tool as you work.\n` +
          `- Do not call plan(command="complete") until the stopping condition is verifiably true.\n` +
          `- If you genuinely need user input, call plan(command="pause") with a reason.\n\n` +
          `Objective:\n${objective}`,
        `Plan approved: goal ${active.goalId} retargeted`,
      );
    }).pipe(
      Effect.catch((err) => {
        const reason = toErrorMessage(err);
        return Effect.logWarning(
          'Failed to retarget in-flight goal for approved plan; returning an explicit error result.',
        ).pipe(
          Effect.annotateLogs({ data: err }),
          withLogChannel(CHANNEL),
          Effect.as(
            errorResult(
              `The user approved this plan and requested autonomous run, ` +
                `but the in-flight goal could not be retargeted: ${reason}\n\n` +
                `Work toward the new objective turn-by-turn. The pre-existing ` +
                `goal is still active and will keep injecting continuations ` +
                `against its previous objective until the user pauses or abandons it.`,
              {
                summary:
                  'Plan approved: goal could not be retargeted, proceeding without it',
              },
            ),
          ),
        );
      }),
    );
  }

  return yield* Effect.gen(function* () {
    const goal = yield* startGoal(call.run.session, runId, objective);
    setGoalSessionAutoApproval(call.run.session, runId, autoApprovalScope);
    return executed(
      `The user approved this plan and started an autonomous goal ` +
        `(${goal.goalId}) toward its stopping condition.\n\n` +
        `Discipline:\n` +
        `- Track concrete steps with the todo tool as you work.\n` +
        `- Do not call plan(command="complete") until the stopping condition is verified against current external state (file contents, command output, test results).\n` +
        `- If you genuinely need user input, call plan(command="pause") with a reason describing what you need.\n` +
        `- Otherwise, keep working until the objective is done.\n\n` +
        `Objective:\n${objective}`,
      `Plan approved: goal ${goal.goalId} started`,
    );
  }).pipe(
    Effect.catch((err) => {
      const reason = toErrorMessage(err);
      return Effect.logWarning(
        'Failed to start goal for approved plan; falling back to plain approval.',
      ).pipe(
        Effect.annotateLogs({ data: err }),
        withLogChannel(CHANNEL),
        Effect.as(
          executed(
            `The user approved this plan and requested autonomous run, but ` +
              `the goal could not be started: ${reason}\n\n` +
              `Work toward the objective as a normal turn-by-turn workflow, ` +
              `tracking concrete steps with the todo tool.`,
            'Plan approved: goal could not be started, proceeding without it',
          ),
        ),
      );
    }),
  );
});

/**
 * Request user approval for a new plan. Pauses run until approved/rejected.
 */
const requestApproval = Effect.fn('PlanTool.requestApproval')(function* (
  call: RunToolCall,
  plan: Plan,
  runId: RunId,
  workPlanState: WorkPlanState,
) {
  const requestId = call.requests.nextId('plan');

  yield* Effect.logInfo('Requesting approval for plan objective').pipe(
    withLogChannel(CHANNEL),
  );

  const result = yield* call.requests.open({
    kind: 'planApproval',
    // The tool is offered only while the goal plugin is on, so the user can
    // always run an approved plan as a goal.
    data: { requestId, runId, plan },
  });

  if (result.action === 'approve') {
    yield* Effect.logInfo('Plan approved by user').pipe(
      withLogChannel(CHANNEL),
    );
    return buildApprovedResult();
  }

  if (result.action === 'approve_and_goal') {
    yield* Effect.logInfo('Plan approved by user with goal mode').pipe(
      withLogChannel(CHANNEL),
    );
    return yield* startGoalForPlan(
      call,
      plan,
      runId,
      result.autoApproveAll ? 'allAgentWork' : 'commands',
    );
  }

  // Rejected — clear the plan from UI
  workPlanState.updatePlan(null);

  const refusal = refusalOf('planApproval', result);

  // 'cancelled' and 'policy' differ only in wording: a host cancel with an
  // optional cause vs a policy denial with its reason.
  const denialResult = (
    outcome: string,
    detail?: string,
  ): Effect.Effect<ToolResult> => {
    const trimmed = detail?.trim();
    return Effect.logInfo(`Plan approval ${outcome}`).pipe(
      Effect.annotateLogs(trimmed ? { data: trimmed } : {}),
      withLogChannel(CHANNEL),
      Effect.as(
        errorResult(
          trimmed
            ? `Plan approval was ${outcome}.\n\n${trimmed}`
            : `Plan approval was ${outcome}.`,
          { summary: `Plan approval ${outcome}` },
        ),
      ),
    );
  };

  switch (refusal.action) {
    case 'cancel':
      return yield* denialResult('cancelled', refusal.cause ?? undefined);
    case 'deny':
      return yield* denialResult('denied', refusal.reason);
    case 'reject': {
      const feedback = refusal.feedback?.trim();
      const feedbackNote = feedback
        ? `\nUser feedback: ${feedback}`
        : '\nNo specific feedback was provided.';

      yield* Effect.logInfo('Plan rejected by user').pipe(
        Effect.annotateLogs({ data: feedback }),
        withLogChannel(CHANNEL),
      );

      return errorResult(
        `The user rejected this plan.${feedbackNote}\nPlease revise your approach based on the feedback and create an updated plan.`,
        {
          summary: 'Plan rejected: revise approach',
          ...(feedback ? { userInstruction: feedback } : {}),
        },
      );
    }
  }
});

const executeUpdate = Effect.fn('PlanTool.executeUpdate')(function* (
  call: RunToolCall,
  plan: Plan,
) {
  if (!call.workPlanState) {
    return yield* Effect.fail(
      new ToolError(
        'plan(update) requires an active agent tool-use turn: there is no work plan to update.',
      ),
    );
  }

  call.workPlanState.updatePlan(plan);

  // Every update is a (re-)proposal: with no step statuses to record,
  // the only reason to call update is a new or changed objective, and
  // that decision belongs to the user.
  return yield* requestApproval(call, plan, call.run.runId, call.workPlanState);
});

const executePause = Effect.fn('PlanTool.executePause')(function* (
  call: RunToolCall,
  runId: RunId,
  reason: string,
) {
  const goal = goalOf(call.run.session, runId);
  if (!goal) {
    return executed(
      'No autonomous goal is currently running on this run, so there is nothing to pause. ' +
        'If you need user input, ask the user directly in your next message; do not call plan(command="pause") again.',
      'No autonomous goal to pause.',
    );
  }
  if (goal.status !== 'active') {
    return executed(
      `Goal is ${goal.status}; pause is a no-op.\n\n${formatGoalView(goal, yield* Clock.currentTimeMillis)}`,
      `Goal already ${goal.status}: pause is a no-op.`,
    );
  }
  const updated = (yield* pauseGoal(call.run.session, runId)) ?? goal;
  setGoalSessionAutoApproval(call.run.session, runId, false);
  return executed(
    `Goal paused: ${reason}\n\n${formatGoalView(updated, yield* Clock.currentTimeMillis)}`,
    'Goal paused.',
  );
});

const executeComplete = Effect.fn('PlanTool.executeComplete')(function* (
  call: RunToolCall,
  runId: RunId,
  reason: string,
) {
  const goal = goalOf(call.run.session, runId);
  if (!goal) {
    return executed(
      'No autonomous goal is currently running on this run, so there is nothing to mark complete. ' +
        'The plan work is otherwise finished; return the final answer to the user and do not call plan(command="complete") again.',
      'Plan-only work complete: summarize the result.',
    );
  }
  // Completing ends the pursuit — a goal is a live one, not an archived one.
  // The autonomous loop stops because the run's next row states that no goal
  // is in flight for the wait-node continuation check.
  yield* clearGoal(call.run.session, runId);
  setGoalSessionAutoApproval(call.run.session, runId, false);
  return executed(
    `Goal ${goal.goalId} marked complete.\n\n` +
      `Reason: ${reason}\n\n` +
      `The autonomous continuation loop has stopped. ` +
      `Returning control to the user.`,
    'Goal complete.',
  );
});

/**
 * Build the program for one plan command from the invocation capability.
 */
function planCommand(
  call: RunToolCall,
  input: PlanToolInput,
): Effect.Effect<ToolResult, Error> {
  switch (input.command) {
    case 'update':
      return executeUpdate(call, { objective: input.objective });
    case 'pause':
    case 'complete': {
      const reason = requireNonEmptyString(input.reason, 'reason');
      return input.command === 'pause'
        ? executePause(call, call.run.runId, reason)
        : executeComplete(call, call.run.runId, reason);
    }
  }
}

export const PlanTool = defineTool({
  name: 'plan',
  requiresApproval: 'inBody',
  description: `Manage the plan document and (optionally) the autonomous goal pursuing it.

Commands:
- update: Propose or replace the plan. Required field: \`objective\` - a plain document stating what to achieve, the intended approach, and a verifiable stopping condition. Every update is presented to the user for approval; they may approve, run the plan as a goal, or reject. Update only when the objective or approach genuinely changes.
- pause: Self-pause the goal pursuing this plan when you genuinely need user input to proceed. Required field: \`reason\` describing what you need.
- complete: Mark the goal pursuing this plan complete. Required field: \`reason\` describing how you verified completion against current external state. Only call this once the objective's stopping condition is verifiably true.

pause/complete only affect autonomous goals; with no goal running they return guidance for ordinary chat.`,
  schema: PlanToolInputSchema,
  execute: (input: PlanToolInput) =>
    Effect.gen(function* () {
      const call = yield* ToolCall;
      if (call.run === undefined) {
        return yield* Effect.fail(
          new ToolError('plan requires an active agent run.'),
        );
      }
      return yield* planCommand(call, input);
    }),
});
