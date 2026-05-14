/**
 * Plan tool for creating structured implementation plans during tool-use agent sessions.
 *
 * Unlike todo_write (which tracks execution progress), this tool lets the agent
 * outline an implementation strategy with numbered steps, descriptions, and file
 * references — giving the user visibility into the agent's approach before and
 * during execution.
 *
 * When a new plan is created (all steps pending), the tool pauses execution and
 * waits for user approval before returning. Progress updates (steps already
 * in_progress or completed) are applied immediately without approval.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import type { WorkPlanState } from '@agent/core/AgentWorkspaceState';
import type { PlanApprovalResult } from '@agent/runtime/PlanApprovalCoordinator';
import { waitForPlanApproval } from '@agent/runtime/runCoordinators';
import { getCurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TODO_STATUS,
  STATUS_DISPLAY,
  PlanSchema,
  countByStatus,
  type Plan,
} from '@shared/schemas';
import { isProposalBypassedForStream } from '@tools/approval';
import { type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const logger = new AgentLogger('PlanTool');

/** Counter for generating unique approval IDs */
let approvalCounter = 0;

/**
 * Schema for the plan tool input.
 * Uses PlanSchema from shared schemas as single source of truth.
 */
const PlanToolInputSchema = z.strictObject({
  /** The implementation plan */
  plan: PlanSchema.describe('The structured implementation plan'),
});

export type PlanToolInput = z.infer<typeof PlanToolInputSchema>;

/**
 * Tool for creating structured implementation plans during agent sessions.
 *
 * Use this tool to:
 * - Outline a strategy before implementing complex changes
 * - Show users the planned approach with steps, descriptions, and files
 * - Track which plan steps are being worked on or completed
 *
 * Each step has:
 * - title: Short name for the step
 * - description: What the step involves
 * - status: pending | in_progress | completed
 * - files: Optional list of files involved
 *
 * When you create a NEW plan (all steps pending), execution pauses until the
 * user approves. If the user rejects, you will receive their feedback and
 * should revise your approach accordingly. Progress updates (updating step
 * statuses on an existing plan) are applied immediately.
 */
export class PlanTool extends defineTool({
  name: 'plan',
  description: `Create a structured implementation plan to outline your approach before executing.

Use this tool to:
- Present a clear strategy to the user before making changes
- Break down complex tasks into numbered steps with descriptions
- Show which files will be involved in each step
- Track progress through the plan as you work

IMPORTANT: When you create a new plan (all steps are "pending"), the plan is
presented to the user for approval. Execution pauses until they approve or reject.
If rejected, you receive their feedback and should revise the plan. Progress
updates (marking steps in_progress or completed) are applied immediately.

Plan structure:
- summary: Brief overview of the approach (1-3 sentences)
- steps: Ordered list of implementation steps, each with:
  - title: Short step name (e.g., "Add authentication middleware")
  - description: What the step involves and why
  - status: pending | in_progress | completed
  - files: List of files that will be created or modified

Best practices:
- Create the plan BEFORE starting implementation
- Keep summaries concise — focus on the "why" and high-level "what"
- Each step should be a distinct, meaningful unit of work
- Update step statuses as you progress through the plan
- Include file paths to help the user understand the scope`,
  schema: PlanToolInputSchema,
}) {
  protected async execute(input: PlanToolInput): Promise<ToolResult> {
    const contexts = getCurrentToolContexts();
    const callContext = contexts?.callContext;
    const runContext = contexts?.runContext;

    if (!callContext?.workPlanState) {
      logger.warn(
        'plan called without workPlanState in context — plan will not persist or display in UI',
      );
      return {
        summary: 'Created plan (no active session)',
        output: this.formatPlan(input.plan),
        diagnostics: {
          warning: 'No active plan context — plan may not persist',
        },
      };
    }

    // Determine if this is a new plan (all steps pending) vs. a progress update
    const isNewPlan = input.plan.steps.every(
      (s) => s.status === TODO_STATUS.PENDING,
    );

    // Show the plan in the UI immediately
    callContext.workPlanState.updatePlan(input.plan);

    if (isNewPlan) {
      if (!runContext?.streamId) {
        logger.warn(
          'New plan created without streamId — skipping approval gate',
        );
      } else if (isProposalBypassedForStream(runContext.streamId)) {
        logger.info('Plan auto-approved via delegated-task auto-approval');
        return this.buildApprovedResult({ autoApproved: true });
      } else {
        return this.requestApproval(
          input.plan,
          runContext.streamId,
          callContext.workPlanState,
        );
      }
    }

    return this.buildProgressResult(input.plan);
  }

  /**
   * Request user approval for a new plan. Pauses execution until approved/rejected.
   */
  private async requestApproval(
    plan: Plan,
    streamId: string,
    workPlanState: WorkPlanState,
  ): Promise<ToolResult> {
    const approvalId = `plan-${Date.now().toString(36)}-${++approvalCounter}`;

    logger.info(`Requesting approval for plan: ${plan.summary}`);

    const result: PlanApprovalResult = await waitForPlanApproval(streamId, {
      approvalId,
      plan,
    });

    if (result.action === 'approve') {
      logger.info('Plan approved by user');
      return this.buildApprovedResult({ autoApproved: false });
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

  private buildApprovedResult({
    autoApproved,
  }: {
    autoApproved: boolean;
  }): ToolResult {
    const prefix = autoApproved
      ? 'Plan auto-approved via delegated-task auto-approval (user did not review).'
      : 'Plan approved by the user.';
    return {
      summary: autoApproved
        ? 'Plan auto-approved — proceed with implementation'
        : 'Plan approved — proceed with implementation',
      output: `${prefix} You may now begin implementing the plan steps. Update step statuses as you work through them.`,
    };
  }

  /**
   * Build result for a progress update (no approval needed).
   */
  private buildProgressResult(plan: Plan): ToolResult {
    const { completed, inProgress, pending } = countByStatus(plan.steps);

    const summary = `Plan updated: ${completed} completed, ${inProgress} in progress, ${pending} pending`;

    return {
      summary,
      output: 'OK',
    };
  }

  /**
   * Format the plan for display in the tool output (fallback when no UI context).
   */
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
