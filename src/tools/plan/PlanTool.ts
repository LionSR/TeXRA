/**
 * Unified plan + goal tool.
 *
 * `command: 'update'` (the default) creates or updates a structured
 * implementation plan with numbered steps, descriptions, and file
 * references. New plans (all steps pending) gate on user approval; the
 * user may approve the plan or approve and start an autonomous goal.
 *
 * `command: 'pause'` and `command: 'complete'` drive the lifecycle of the
 * goal running this plan: pause when user input is needed, complete
 * when every plan step is verified done. Both are no-ops if no goal
 * is in flight on the current stream.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import type { WorkPlanState } from '@agent/core/execution/AgentWorkspaceState';
import type { PlanApprovalResult } from '@agent/runtime/PlanApprovalCoordinator';
import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { getCurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import type { CurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import { toErrorMessage } from '@common/errors';
import { createChannelTrace } from '@logger';
import {
  TODO_STATUS,
  STATUS_DISPLAY,
  PlanSchema,
  countByStatus,
  type Plan,
} from '@shared/schemas';
import { proposalApprovalState } from '@tools/approval';
import {
  GoalStore,
  formatGoalTime,
  isGoalEnabled,
  isGoalInFlight,
  goalElapsedMs,
  setGoalSessionAutoApprovals,
  type Goal,
} from '@tools/goal';
import { ToolError, type ToolResult } from '@tools/result';
import { requireNonEmptyString } from '@tools/utils';
import {
  appendWorkPlanGranularityWarning,
  formatWorkPlanGranularityWarning,
} from '@tools/workPlanGranularityFeedback';
import { defineTool } from '@tools/core/define';

const logger = createChannelTrace('PlanTool');

/** Counter for generating unique approval IDs */
let approvalCounter = 0;

/**
 * Render a plan as a goal objective: a verifiable stopping condition that
 * names each step so the autonomous loop has the full structure in context,
 * not just the summary.
 */
function buildGoalObjectiveFromPlan(plan: Plan): string {
  const stepLines = plan.steps.map((step, i) => {
    const head = `${i + 1}. ${step.title} — ${step.description}`;
    return step.files.length > 0
      ? `${head}\n   Files: ${step.files.join(', ')}`
      : head;
  });
  return [
    `Complete the following plan in full, then stop.`,
    ``,
    `Plan summary: ${plan.summary}`,
    ``,
    `Steps:`,
    ...stepLines,
    ``,
    `Stopping condition: every step above has been marked completed via the plan tool AND verified against current external state (file contents, command output, or test results).`,
  ].join('\n');
}

function formatGoalView(goal: Goal): string {
  return [
    `Goal: ${goal.goalId}`,
    `Status: ${goal.status}`,
    `Time elapsed: ${formatGoalTime(goalElapsedMs(goal))}`,
  ].join('\n');
}

/**
 * Schema for the unified plan tool input. A discriminated union over
 * `command`: 'update' carries the plan; 'pause'/'complete' carry a reason.
 */
const PlanToolInputSchema = z.discriminatedUnion('command', [
  z.strictObject({
    command: z.literal('update'),
    plan: PlanSchema.describe('The structured implementation plan'),
  }),
  z.strictObject({
    command: z.literal('pause'),
    reason: z
      .string()
      .min(1)
      .describe('Why you are pausing — describe what you need from the user.'),
  }),
  z.strictObject({
    command: z.literal('complete'),
    reason: z
      .string()
      .min(1)
      .describe(
        'How you verified completion — cite current filesystem state, ' +
          'test output, or command results (never conversation memory).',
      ),
  }),
]);

export type PlanToolInput = z.infer<typeof PlanToolInputSchema>;

export class PlanTool extends defineTool({
  name: 'plan',
  description: `Manage a structured implementation plan and (optionally) the autonomous goal running it.

Commands:
- update: Create or update the plan. Required field: \`plan\` with summary + steps. New plans (all steps pending) are presented to the user for approval; they may approve, approve & run autonomously (starts a goal), or reject. Progress updates (marking steps in_progress or completed) apply immediately.
- pause: Self-pause the goal running this plan when you genuinely need user input to proceed. Required field: \`reason\` describing what you need.
- complete: Mark the goal running this plan complete. Required field: \`reason\` describing HOW you verified completion against current external state. Only call this once every plan step is marked completed AND verified.

Plan structure (for command="update"):
- summary: Brief overview of the approach (1-3 sentences).
- steps: Ordered list of implementation steps, each with:
  - title: Short step name (e.g., "Add authentication middleware").
  - description: What the step involves and why.
  - status: pending | in_progress | completed.
  - files: List of files that will be created or modified.

Best practices:
- Create the plan BEFORE starting implementation.
- Keep summaries concise — focus on "why" and high-level "what".
- Each step should be a distinct, meaningful unit of work.
- Update step statuses as you progress through the plan.
- Include file paths to help the user understand the scope.
- pause/complete are no-ops if no goal is running on this stream.`,
  schema: PlanToolInputSchema,
}) {
  protected async execute(input: PlanToolInput): Promise<ToolResult> {
    const contexts = getCurrentToolContexts();
    const streamId = contexts?.runContext?.streamId;

    switch (input.command) {
      case 'update':
        return this.executeUpdate(input.plan, contexts);
      case 'pause':
        if (!streamId) {
          throw new ToolError('plan(pause) requires an active stream context.');
        }
        return this.executePause(
          streamId,
          requireNonEmptyString(input.reason, 'reason'),
        );
      case 'complete':
        if (!streamId) {
          throw new ToolError(
            'plan(complete) requires an active stream context.',
          );
        }
        return this.executeComplete(
          streamId,
          requireNonEmptyString(input.reason, 'reason'),
        );
    }
  }

  private async executeUpdate(
    plan: Plan,
    contexts: CurrentToolContexts | undefined,
  ): Promise<ToolResult> {
    const callContext = contexts?.callContext;
    const runContext = contexts?.runContext;

    if (!callContext?.workPlanState) {
      logger.warn(
        'plan called without workPlanState in context — plan will not persist or display in UI',
      );
      return {
        summary: 'Created plan (no active session)',
        output: this.formatPlan(plan),
        diagnostics: {
          warning: 'No active plan context — plan may not persist',
        },
      };
    }

    const isNewPlan = plan.steps.every((s) => s.status === TODO_STATUS.PENDING);
    const granularityWarning = formatWorkPlanGranularityWarning(
      callContext.workPlanState.todos,
      plan,
    );

    callContext.workPlanState.updatePlan(plan);

    if (isNewPlan) {
      if (!runContext?.streamId) {
        logger.warn(
          'New plan created without streamId — skipping approval gate',
        );
      } else if (proposalApprovalState.isBypassed(runContext.streamId)) {
        logger.info('Plan auto-approved via delegated-task auto-approval');
        return this.buildApprovedResult({
          autoApproved: true,
          granularityWarning,
        });
      } else {
        return this.requestApproval(
          plan,
          runContext.streamId,
          callContext.workPlanState,
          granularityWarning,
        );
      }
    }

    return this.buildProgressResult(plan, granularityWarning);
  }

  private async executePause(
    streamId: string,
    reason: string,
  ): Promise<ToolResult> {
    const goal = GoalStore.getForStream(streamId);
    if (!goal) {
      return {
        summary: 'No goal running — pause is a no-op.',
        output:
          'No autonomous goal is currently running on this stream. ' +
          'If you need user input, return a message describing what you need; ' +
          'no pause is necessary.',
      };
    }
    if (goal.status !== 'active') {
      return {
        summary: `Goal already ${goal.status} — pause is a no-op.`,
        output: `Goal is ${goal.status}; pause is a no-op.\n\n${formatGoalView(goal)}`,
      };
    }
    const updated = (await GoalStore.setStatus(streamId, 'paused')) ?? goal;
    await this.setAutoApprovals(streamId, false);
    return {
      summary: 'Goal paused.',
      output: `Goal paused: ${reason}\n\n${formatGoalView(updated)}`,
    };
  }

  /**
   * Engage/clear the goal's bash + edit auto-approval bypass when the run
   * context can reach the host. Best-effort: without a runtime host (e.g.
   * tests or headless edge paths) approvals simply keep prompting.
   */
  private async setAutoApprovals(
    streamId: string,
    enabled: boolean,
  ): Promise<void> {
    const runtimeHost = getCurrentToolContexts()?.runContext?.runtimeHost;
    if (runtimeHost) {
      await setGoalSessionAutoApprovals(streamId, enabled, runtimeHost);
    }
  }

  private async executeComplete(
    streamId: string,
    reason: string,
  ): Promise<ToolResult> {
    const goal = GoalStore.getForStream(streamId);
    if (!goal) {
      return {
        summary: 'No goal running — complete is a no-op.',
        output:
          'No autonomous goal is currently running on this stream. ' +
          'The plan is the only artifact; you may simply summarize the result for the user.',
      };
    }
    // Completing forgets the record — a goal is a live pursuit, not an
    // archived one. The autonomous loop stops because no `active` record
    // remains for the next wait-node continuation check.
    await GoalStore.forget(streamId);
    await this.setAutoApprovals(streamId, false);
    return {
      summary: 'Goal complete.',
      output:
        `Goal ${goal.goalId} marked complete.\n\n` +
        `Reason: ${reason}\n\n` +
        `The autonomous continuation loop has stopped. ` +
        `Returning control to the user.`,
    };
  }

  /**
   * Request user approval for a new plan. Pauses execution until approved/rejected.
   */
  private async requestApproval(
    plan: Plan,
    streamId: string,
    workPlanState: WorkPlanState,
    granularityWarning?: string,
  ): Promise<ToolResult> {
    const approvalId = `plan-${Date.now().toString(36)}-${++approvalCounter}`;
    const goalEnabled = isGoalEnabled();

    logger.info(`Requesting approval for plan: ${plan.summary}`);

    const result: PlanApprovalResult =
      await runCoordinatorBridge.waitForPlanApproval(streamId, {
        approvalId,
        plan,
        goalEnabled,
      });

    if (result.action === 'approve') {
      logger.info('Plan approved by user');
      return this.buildApprovedResult({
        autoApproved: false,
        granularityWarning,
      });
    }

    if (result.action === 'approve_and_goal') {
      logger.info('Plan approved by user with goal mode');
      return this.startGoalForPlan(plan, streamId, granularityWarning);
    }

    // Rejected or timed out — clear the plan from UI
    workPlanState.updatePlan(null);

    if (result.action === 'timeout') {
      logger.warn('Plan approval timed out');
      return {
        summary: 'Plan approval timed out',
        output:
          'The plan approval request timed out before the user responded. Please try again or proceed without a plan.',
        isError: true,
      };
    }

    const feedback = result.feedback;
    const feedbackNote = feedback
      ? `\nUser feedback: ${feedback}`
      : '\nNo specific feedback was provided.';

    logger.info(`Plan rejected by user${feedback ? `: ${feedback}` : ''}`);

    return {
      summary: 'Plan rejected — revise approach',
      output: `The user rejected this plan.${feedbackNote}\nPlease revise your approach based on the feedback and create an updated plan.`,
      isError: true,
      ...(feedback ? { userInstruction: feedback } : {}),
    };
  }

  /**
   * Start an autonomous goal whose objective is the just-approved plan.
   * Falls back explicitly if goal is disabled. If one is already in flight
   * for the stream, retarget that goal to the newly approved plan so future
   * continuations follow the current user decision.
   */
  private async startGoalForPlan(
    plan: Plan,
    streamId: string,
    granularityWarning?: string,
  ): Promise<ToolResult> {
    const goalEnabled = isGoalEnabled();
    if (!goalEnabled) {
      logger.warn(
        'Approve & Run Autonomously requested but goal feature flag is off; ' +
          'continuing without an autonomous goal.',
      );
      return {
        summary: 'Plan approved — autonomous run unavailable',
        output: appendWorkPlanGranularityWarning(
          `The user selected Approve & Run, but the goal feature flag is ` +
            `currently disabled. The plan is approved, but no autonomous ` +
            `goal was started.\n\n` +
            `Proceed with the plan steps as a normal turn-by-turn workflow. ` +
            `Update plan step statuses as you go.`,
          granularityWarning,
        ),
      };
    }

    const objective = buildGoalObjectiveFromPlan(plan);

    // If a goal is already in flight on this stream, retarget it at
    // the newly approved plan instead of silently leaving the loop driving
    // the stale objective. `editObjective` resets the continuation budget so
    // the new plan gets a fresh cap regardless of whether the prior goal
    // was active or paused — see goalStore.editObjective for the rationale.
    const existing = GoalStore.getForStream(streamId);
    if (isGoalInFlight(existing)) {
      try {
        const retargeted = await GoalStore.editObjective(streamId, objective, {
          plan,
        });
        const active =
          retargeted.status === 'paused'
            ? ((await GoalStore.setStatus(streamId, 'active')) ?? retargeted)
            : retargeted;
        await this.setAutoApprovals(streamId, true);
        return {
          summary: `Plan approved — goal ${active.goalId} retargeted`,
          output: appendWorkPlanGranularityWarning(
            `The user approved a new plan while goal ${active.goalId} ` +
              `was already in flight. The goal has been retargeted to ` +
              `the newly approved plan instead of leaving the old objective ` +
              `active.\n\n` +
              `${formatGoalView(active)}\n\n` +
              `Discipline:\n` +
              `- Work through the new plan steps and update their statuses with plan(command="update") as you progress.\n` +
              `- Discard any progress that only served the previous objective.\n` +
              `- Do not call plan(command="complete") until every step of the new plan is marked completed AND verified.\n` +
              `- If you genuinely need user input to proceed, call plan(command="pause") with a reason.\n\n` +
              `Objective:\n${objective}`,
            granularityWarning,
          ),
        };
      } catch (err) {
        const reason = toErrorMessage(err);
        logger.warn(
          `Failed to retarget in-flight goal for approved plan; returning an explicit error result. ${reason}`,
        );
        return {
          summary:
            'Plan approved — goal could not be retargeted, proceeding without it',
          output:
            `The user approved this plan and requested autonomous execution, ` +
            `but the in-flight goal could not be retargeted: ${reason}\n\n` +
            `Proceed with the plan steps turn-by-turn. The pre-existing ` +
            `goal is still active and will keep injecting continuations ` +
            `against its previous objective until the user pauses or abandons it.`,
          isError: true,
        };
      }
    }

    try {
      const goal = await GoalStore.start(streamId, objective, { plan });
      await this.setAutoApprovals(streamId, true);
      return {
        summary: `Plan approved — goal ${goal.goalId} started`,
        output: appendWorkPlanGranularityWarning(
          `The user approved this plan and started an autonomous goal ` +
            `(${goal.goalId}) toward the plan's stopping condition.\n\n` +
            `Discipline:\n` +
            `- Work through the plan steps and update their statuses with plan(command="update") as you progress.\n` +
            `- Do not call plan(command="complete") until every plan step is marked completed AND the result is verified against current external state (file contents, command output, test results).\n` +
            `- If you genuinely need user input to proceed, call plan(command="pause") with a reason describing what you need.\n` +
            `- Otherwise, keep working in scoped checkpoints until the plan is finished.\n\n` +
            `Objective:\n${objective}`,
          granularityWarning,
        ),
      };
    } catch (err) {
      const reason = toErrorMessage(err);
      logger.warn(
        `Failed to start goal for approved plan; falling back to plain approval. ${reason}`,
      );
      return {
        summary:
          'Plan approved — goal could not be started, proceeding without it',
        output:
          `The user approved this plan and requested autonomous execution, but ` +
          `the goal could not be started: ${reason}\n\n` +
          `Proceed with the plan steps as a normal turn-by-turn workflow. Update ` +
          `plan step statuses as you go.`,
      };
    }
  }

  private buildApprovedResult({
    autoApproved,
    granularityWarning,
  }: {
    autoApproved: boolean;
    granularityWarning?: string;
  }): ToolResult {
    const prefix = autoApproved
      ? 'Plan auto-approved via delegated-task auto-approval (user did not review).'
      : 'Plan approved by the user.';
    return {
      summary: autoApproved
        ? 'Plan auto-approved — proceed with implementation'
        : 'Plan approved — proceed with implementation',
      output: appendWorkPlanGranularityWarning(
        `${prefix} You may now begin implementing the plan steps. Update step statuses as you work through them.`,
        granularityWarning,
      ),
    };
  }

  private buildProgressResult(
    plan: Plan,
    granularityWarning: string | undefined,
  ): ToolResult {
    const { completed, inProgress, pending } = countByStatus(plan.steps);

    const summary = `Plan updated: ${completed} completed, ${inProgress} in progress, ${pending} pending`;

    return {
      summary: granularityWarning
        ? `${summary}; todo/plan granularity overlap`
        : summary,
      output: appendWorkPlanGranularityWarning('OK', granularityWarning),
    };
  }

  private formatPlan(plan: Plan): string {
    const lines: string[] = [`Plan: ${plan.summary}`, ''];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step) continue;
      const { icon, label } = STATUS_DISPLAY[step.status];
      lines.push(`${i + 1}. ${icon} [${label}] ${step.title}`);
      lines.push(`   ${step.description}`);
      if (step.files.length > 0) {
        lines.push(`   Files: ${step.files.join(', ')}`);
      }
    }

    return lines.join('\n');
  }
}
