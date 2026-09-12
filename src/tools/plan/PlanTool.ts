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
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import type { WorkPlanState } from '@agent/core/state/AgentWorkspaceState';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { hostPort } from '@common/hostPort';
import { createLog } from '@logger/logUtils';
import type { Goal, Plan, RunId, ToolResult } from '@shared/schemas';
import { goalElapsedMs, ToolError } from '@shared/schemas';
import { refusalOf } from '@shared/session/approvalDecision';
import {
  clearGoal,
  goalOf,
  isGoalEnabled,
  pauseGoal,
  retargetGoal,
  setGoalSessionAutoApproval,
  startGoal,
  type GoalAutoApprovalScope,
} from '@tools/goal';
import { requireNonEmptyString } from '@tools/utils';
import { defineTool } from '@tools/core/define';
import { errorResult, executed } from '@tools/core/result';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatCompactDuration } from '@utils/text/stringUtils';

const logger = createLog('PlanTool');

function formatGoalView(goal: Goal): string {
  return [
    `Goal: ${goal.goalId}`,
    `Status: ${goal.status}`,
    `Time elapsed: ${formatCompactDuration(goalElapsedMs(goal))}`,
  ].join('\n');
}

/**
 * Schema for the unified plan tool input. A discriminated union over
 * `command`: 'update' carries the plan; 'pause'/'complete' carry a reason.
 *
 * Branches use looseObject (not strictObject): provider conversion flattens
 * the union into one advertised object and OpenAI-compatible providers
 * null-fill the properties belonging to the other commands. See AGENTS.md
 * "Tool input schemas".
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
 * Everything this tool's program needs from its invocation capability.
 *
 * The goal feature flag resolves `workspaceRoots()` — per-session config
 * whose fallback is the process (no-workspace) roots — so it is read through
 * the call's narrow legacy host frame. The goal itself is the session's own
 * `goalStateChanged` row, read and written through `ports.session`.
 */
interface PlanPorts {
  /** One native tool-call capability, scoped by the dispatcher. */
  readonly call: ToolCallShape;
  /** The session that owns this turn; it holds the approval surface. */
  readonly session: NonNullable<ToolCallShape['run']>['session'];
}

/**
 * Engage or clear the goal's selected auto-approval scope when the run
 * context can reach the host. Best-effort: without a runtime host (e.g.
 * tests or headless edge paths) approvals simply keep prompting.
 */
const setGoalAutoApproval = Effect.fn('PlanTool.setGoalAutoApproval')(
  function* (
    ports: PlanPorts,
    runId: RunId,
    scope: GoalAutoApprovalScope | false,
  ) {
    if (ports.call.run) {
      yield* hostPort(() =>
        setGoalSessionAutoApproval(runId, scope, {
          session: ports.session,
        }),
      );
    }
  },
);

/**
 * Start an autonomous goal whose objective is the just-approved plan
 * document, verbatim. Falls back explicitly if goal is disabled. If one
 * is already in flight for the run, retarget it so future
 * continuations follow the current user decision.
 */
const startGoalForPlan = Effect.fn('PlanTool.startGoalForPlan')(function* (
  ports: PlanPorts,
  plan: Plan,
  runId: RunId,
  autoApprovalScope: GoalAutoApprovalScope,
) {
  if (!ports.call.inScope(isGoalEnabled)) {
    logger.warn(
      'Run as Goal requested but goal feature flag is off; ' +
        'continuing without an autonomous goal.',
    );
    return executed(
      `The user selected Run as Goal, but the goal feature flag is ` +
        `currently disabled. The plan is approved, but no autonomous ` +
        `goal was started.\n\n` +
        `Work toward the objective as a normal turn-by-turn workflow, ` +
        `tracking concrete steps with the todo tool.`,
      'Plan approved: autonomous run unavailable',
    );
  }

  const objective = plan.objective;

  // If a goal is already in flight on this run, retarget it at the
  // newly approved objective instead of silently leaving the loop driving
  // the stale one.
  if (goalOf(ports.session, runId)) {
    return yield* Effect.gen(function* () {
      const active = yield* Effect.try({
        try: () => retargetGoal(ports.session, runId, objective),
        catch: (error) => error,
      });
      yield* setGoalAutoApproval(ports, runId, autoApprovalScope);
      return executed(
        `The user approved a new plan while goal ${active.goalId} ` +
          `was already in flight. The goal has been retargeted to the ` +
          `new objective.\n\n` +
          `${formatGoalView(active)}\n\n` +
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
        logger.warn(
          'Failed to retarget in-flight goal for approved plan; returning an explicit error result.',
          { data: err },
        );
        return Effect.succeed(
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
        );
      }),
    );
  }

  return yield* Effect.gen(function* () {
    const goal = yield* Effect.try({
      try: () => startGoal(ports.session, runId, objective),
      catch: (error) => error,
    });
    yield* setGoalAutoApproval(ports, runId, autoApprovalScope);
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
      logger.warn(
        'Failed to start goal for approved plan; falling back to plain approval.',
        { data: err },
      );
      return Effect.succeed(
        executed(
          `The user approved this plan and requested autonomous run, but ` +
            `the goal could not be started: ${reason}\n\n` +
            `Work toward the objective as a normal turn-by-turn workflow, ` +
            `tracking concrete steps with the todo tool.`,
          'Plan approved: goal could not be started, proceeding without it',
        ),
      );
    }),
  );
});

/**
 * Request user approval for a new plan. Pauses run until approved/rejected.
 */
const requestApproval = Effect.fn('PlanTool.requestApproval')(function* (
  ports: PlanPorts,
  plan: Plan,
  runId: RunId,
  workPlanState: WorkPlanState,
) {
  const requestId = `plan-${generateShortId()}`;
  const goalEnabled = ports.call.inScope(isGoalEnabled);

  logger.info('Requesting approval for plan objective');

  const result = yield* ports.session.openRequest(runId, {
    kind: 'planApproval',
    data: { requestId, runId, plan, goalEnabled },
  });

  if (result.action === 'approve') {
    logger.info('Plan approved by user');
    return buildApprovedResult();
  }

  if (result.action === 'approve_and_goal') {
    logger.info('Plan approved by user with goal mode');
    return yield* startGoalForPlan(
      ports,
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
  const denialResult = (outcome: string, detail?: string): ToolResult => {
    const trimmed = detail?.trim();
    logger.info(
      `Plan approval ${outcome}`,
      trimmed ? { data: trimmed } : undefined,
    );
    return errorResult(
      trimmed
        ? `Plan approval was ${outcome}.\n\n${trimmed}`
        : `Plan approval was ${outcome}.`,
      { summary: `Plan approval ${outcome}` },
    );
  };

  switch (refusal.action) {
    case 'cancel':
      return denialResult('cancelled', refusal.cause ?? undefined);
    case 'deny':
      return denialResult('denied', refusal.reason);
    case 'reject': {
      const feedback = refusal.feedback?.trim();
      const feedbackNote = feedback
        ? `\nUser feedback: ${feedback}`
        : '\nNo specific feedback was provided.';

      logger.info(
        'Plan rejected by user',
        feedback ? { data: feedback } : undefined,
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
  ports: PlanPorts,
  plan: Plan,
) {
  const callContext = ports.call;
  const run = callContext.run;

  if (!callContext.workPlanState) {
    return yield* Effect.fail(
      new ToolError(
        'plan(update) requires an active agent tool-use turn: there is no work plan to update.',
      ),
    );
  }

  callContext.workPlanState.updatePlan(plan);

  // Every update is a (re-)proposal: with no step statuses to record,
  // the only reason to call update is a new or changed objective, and
  // that decision belongs to the user.
  if (!run) return buildApprovedResult();
  const { runId } = run;
  return yield* requestApproval(ports, plan, runId, callContext.workPlanState);
});

const executePause = Effect.fn('PlanTool.executePause')(function* (
  ports: PlanPorts,
  runId: RunId,
  reason: string,
) {
  const goal = goalOf(ports.session, runId);
  if (!goal) {
    return executed(
      'No autonomous goal is currently running on this run, so there is nothing to pause. ' +
        'If you need user input, ask the user directly in your next message; do not call plan(command="pause") again.',
      'No autonomous goal to pause.',
    );
  }
  if (goal.status !== 'active') {
    return executed(
      `Goal is ${goal.status}; pause is a no-op.\n\n${formatGoalView(goal)}`,
      `Goal already ${goal.status}: pause is a no-op.`,
    );
  }
  const updated = pauseGoal(ports.session, runId) ?? goal;
  yield* setGoalAutoApproval(ports, runId, false);
  return executed(
    `Goal paused: ${reason}\n\n${formatGoalView(updated)}`,
    'Goal paused.',
  );
});

const executeComplete = Effect.fn('PlanTool.executeComplete')(function* (
  ports: PlanPorts,
  runId: RunId,
  reason: string,
) {
  const goal = goalOf(ports.session, runId);
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
  clearGoal(ports.session, runId);
  yield* setGoalAutoApproval(ports, runId, false);
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
  ports: PlanPorts,
  input: PlanToolInput,
): Effect.Effect<ToolResult, unknown> {
  switch (input.command) {
    case 'update':
      return executeUpdate(ports, { objective: input.objective });
    case 'pause':
      return ports.call.run
        ? executePause(
            ports,
            ports.call.run.runId,
            requireNonEmptyString(input.reason, 'reason'),
          )
        : Effect.fail(new ToolError('plan(pause) requires an active run.'));
    case 'complete':
      return ports.call.run
        ? executeComplete(
            ports,
            ports.call.run.runId,
            requireNonEmptyString(input.reason, 'reason'),
          )
        : Effect.fail(new ToolError('plan(complete) requires an active run.'));
  }
}

export class PlanTool extends defineTool({
  name: 'plan',
  requiresApproval: true,
  description: `Manage the plan document and (optionally) the autonomous goal pursuing it.

Commands:
- update: Propose or replace the plan. Required field: \`objective\` - a plain document stating what to achieve, the intended approach, and a verifiable stopping condition. Every update is presented to the user for approval; they may approve, run the plan as a goal, or reject. Update only when the objective or approach genuinely changes.
- pause: Self-pause the goal pursuing this plan when you genuinely need user input to proceed. Required field: \`reason\` describing what you need.
- complete: Mark the goal pursuing this plan complete. Required field: \`reason\` describing how you verified completion against current external state. Only call this once the objective's stopping condition is verifiably true.

pause/complete only affect autonomous goals; with no goal running they return guidance for ordinary chat.`,
  schema: PlanToolInputSchema,
}) {
  protected execute(input: PlanToolInput) {
    return Effect.gen(function* () {
      const call = yield* ToolCall;
      const run = call.run;
      if (!run) {
        return yield* Effect.fail(
          new ToolError('plan requires an active agent run.'),
        );
      }
      return yield* planCommand({ call, session: run.session }, input);
    });
  }
}
