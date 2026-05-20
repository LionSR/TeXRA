/**
 * Unified plan + odyssey tool.
 *
 * `command: 'update'` (the default) creates or updates a structured
 * implementation plan with numbered steps, descriptions, and file
 * references. New plans (all steps pending) gate on user approval; the
 * user may approve the plan or approve and start an autonomous odyssey.
 *
 * `command: 'pause'` and `command: 'complete'` drive the lifecycle of the
 * odyssey running this plan: pause when user input is needed, complete
 * when every plan step is verified done. Both are no-ops if no odyssey
 * is in flight on the current stream.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { tryPlatform } from '@platform/platform';
import type { WorkPlanState } from '@agent/core/AgentWorkspaceState';
import type { PlanApprovalResult } from '@agent/runtime/PlanApprovalCoordinator';
import { waitForPlanApproval } from '@agent/runtime/runCoordinators';
import { getCurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import type { CurrentToolContexts } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TODO_STATUS,
  STATUS_DISPLAY,
  PlanSchema,
  countByStatus,
  type Plan,
} from '@shared/schemas';
import { isProposalBypassedForStream } from '@tools/approval';
import {
  ODYSSEY_FEATURE_FLAG_KEY,
  OdysseyStore,
  formatOdysseyTime,
  isOdysseyInFlight,
  odysseyElapsedMs,
  type Odyssey,
} from '@tools/odyssey';
import { ToolError, type ToolResult } from '@tools/result';
import { requireNonEmptyString } from '@tools/utils';
import { defineTool } from '@tools/core/define';

const logger = new AgentLogger('PlanTool');

/** Counter for generating unique approval IDs */
let approvalCounter = 0;

/**
 * Render a plan as an odyssey objective: a verifiable stopping condition that
 * names each step so the autonomous loop has the full structure in context,
 * not just the summary.
 */
function buildOdysseyObjectiveFromPlan(plan: Plan): string {
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

function formatOdysseyView(odyssey: Odyssey): string {
  return [
    `Odyssey: ${odyssey.odysseyId}`,
    `Status: ${odyssey.status}`,
    `Time elapsed: ${formatOdysseyTime(odysseyElapsedMs(odyssey))}`,
    odyssey.completedReason ? `Reason: ${odyssey.completedReason}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join('\n');
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
  description: `Manage a structured implementation plan and (optionally) the autonomous odyssey running it.

Commands:
- update: Create or update the plan. Required field: \`plan\` with summary + steps. New plans (all steps pending) are presented to the user for approval; they may approve, approve & run autonomously (starts an odyssey), or reject. Progress updates (marking steps in_progress or completed) apply immediately.
- pause: Self-pause the odyssey running this plan when you genuinely need user input to proceed. Required field: \`reason\` describing what you need.
- complete: Mark the odyssey running this plan complete. Required field: \`reason\` describing HOW you verified completion against current external state. Only call this once every plan step is marked completed AND verified.

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
- pause/complete are no-ops if no odyssey is running on this stream.`,
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

    callContext.workPlanState.updatePlan(plan);

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
          plan,
          runContext.streamId,
          callContext.workPlanState,
        );
      }
    }

    return this.buildProgressResult(plan);
  }

  private async executePause(
    streamId: string,
    reason: string,
  ): Promise<ToolResult> {
    const odyssey = OdysseyStore.getForStream(streamId);
    if (!odyssey) {
      return {
        summary: 'No odyssey running — pause is a no-op.',
        output:
          'No autonomous odyssey is currently running on this stream. ' +
          'If you need user input, return a message describing what you need; ' +
          'no pause is necessary.',
      };
    }
    if (odyssey.status !== 'active') {
      return {
        summary: `Odyssey already ${odyssey.status} — pause is a no-op.`,
        output: `Odyssey is ${odyssey.status}; pause is a no-op.\n\n${formatOdysseyView(odyssey)}`,
      };
    }
    const updated =
      (await OdysseyStore.setStatus(streamId, 'paused', reason)) ?? odyssey;
    return {
      summary: 'Odyssey paused.',
      output: `Odyssey paused: ${reason}\n\n${formatOdysseyView(updated)}`,
    };
  }

  private async executeComplete(
    streamId: string,
    reason: string,
  ): Promise<ToolResult> {
    const odyssey = OdysseyStore.getForStream(streamId);
    if (!odyssey) {
      return {
        summary: 'No odyssey running — complete is a no-op.',
        output:
          'No autonomous odyssey is currently running on this stream. ' +
          'The plan is the only artifact; you may simply summarize the result for the user.',
      };
    }
    if (odyssey.status === 'complete') {
      return {
        summary: 'Odyssey already complete.',
        output: `Odyssey is already complete. Reason on record: ${odyssey.completedReason ?? '(none)'}`,
      };
    }
    if (odyssey.status === 'abandoned') {
      throw new ToolError(
        'Odyssey was abandoned by the user; complete is rejected. ' +
          'The user must start a new odyssey explicitly.',
      );
    }
    const updated =
      (await OdysseyStore.setStatus(streamId, 'complete', reason)) ?? odyssey;
    return {
      summary: 'Odyssey complete.',
      output:
        `Odyssey ${updated.odysseyId} marked complete.\n\n` +
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
  ): Promise<ToolResult> {
    const approvalId = `plan-${Date.now().toString(36)}-${++approvalCounter}`;
    const odysseyEnabled =
      tryPlatform()?.config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false) ??
      false;

    logger.info(`Requesting approval for plan: ${plan.summary}`);

    const result: PlanApprovalResult = await waitForPlanApproval(streamId, {
      approvalId,
      plan,
      odysseyEnabled,
    });

    if (result.action === 'approve') {
      logger.info('Plan approved by user');
      return this.buildApprovedResult({ autoApproved: false });
    }

    if (result.action === 'approve_and_odyssey') {
      logger.info('Plan approved by user with odyssey mode');
      return this.startOdysseyForPlan(plan, streamId);
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
   * Start an autonomous odyssey whose objective is the just-approved plan.
   * Falls back to a plain approved result if odyssey is disabled, or if one
   * is already in flight for the stream.
   */
  private async startOdysseyForPlan(
    plan: Plan,
    streamId: string,
  ): Promise<ToolResult> {
    const odysseyEnabled =
      tryPlatform()?.config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false) ??
      false;
    if (!odysseyEnabled) {
      logger.warn(
        'Approve & Run Autonomously requested but odyssey feature flag is off; ' +
          'proceeding as a plain approval.',
      );
      return {
        summary:
          'Plan approved — autonomous run skipped (odyssey feature flag is off)',
        output:
          `The user approved this plan via "Approve & Run", but the odyssey ` +
          `feature flag is currently off, so the autonomous continuation loop ` +
          `was not started. Proceed with the plan steps turn-by-turn; update ` +
          `step statuses as you work through them.`,
      };
    }

    const objective = buildOdysseyObjectiveFromPlan(plan);

    // If an odyssey is already in flight on this stream, retarget it at
    // the newly approved plan instead of silently leaving the loop driving
    // the stale objective. Resuming a paused odyssey keeps the continuation
    // budget so the user-approved cap isn't bypassed by re-targeting.
    const existing = OdysseyStore.getForStream(streamId);
    if (existing && isOdysseyInFlight(existing)) {
      try {
        const retargeted = await OdysseyStore.editObjective(
          streamId,
          objective,
          { plan },
        );
        if (retargeted.status === 'paused') {
          await OdysseyStore.setStatus(
            streamId,
            'active',
            'retargeted to new plan',
          );
        }
        return {
          summary: `Plan approved — odyssey ${retargeted.odysseyId} retargeted`,
          output:
            `The user approved a new plan while odyssey ${retargeted.odysseyId} ` +
            `was already in flight. The odyssey objective has been replaced ` +
            `with the new plan's stopping condition; resume working against ` +
            `it.\n\n` +
            `Discipline:\n` +
            `- Work through the new plan steps and update their statuses with plan(command="update") as you progress.\n` +
            `- Discard any progress that only served the previous objective.\n` +
            `- Do not call plan(command="complete") until every step of the new plan is marked completed AND verified.\n` +
            `- If you genuinely need user input to proceed, call plan(command="pause") with a reason.\n\n` +
            `Objective:\n${objective}`,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Failed to retarget in-flight odyssey for approved plan; falling back to plain approval. ${reason}`,
        );
        return {
          summary:
            'Plan approved — odyssey could not be retargeted, proceeding without it',
          output:
            `The user approved this plan and requested autonomous execution, ` +
            `but the in-flight odyssey could not be retargeted: ${reason}\n\n` +
            `Proceed with the plan steps turn-by-turn. The pre-existing ` +
            `odyssey is still active and will keep injecting continuations ` +
            `against its previous objective until the user pauses or abandons it.`,
          isError: true,
        };
      }
    }

    try {
      const odyssey = await OdysseyStore.start(streamId, objective, { plan });
      return {
        summary: `Plan approved — odyssey ${odyssey.odysseyId} started`,
        output:
          `The user approved this plan and started an autonomous odyssey ` +
          `(${odyssey.odysseyId}) toward the plan's stopping condition.\n\n` +
          `Discipline:\n` +
          `- Work through the plan steps and update their statuses with plan(command="update") as you progress.\n` +
          `- Do not call plan(command="complete") until every plan step is marked completed AND the result is verified against current external state (file contents, command output, test results).\n` +
          `- If you genuinely need user input to proceed, call plan(command="pause") with a reason describing what you need.\n` +
          `- Otherwise, keep working in scoped checkpoints until the plan is finished.\n\n` +
          `Objective:\n${objective}`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Failed to start odyssey for approved plan; falling back to plain approval. ${reason}`,
      );
      return {
        summary:
          'Plan approved — odyssey could not be started, proceeding without it',
        output:
          `The user approved this plan and requested autonomous execution, but ` +
          `the odyssey could not be started: ${reason}\n\n` +
          `Proceed with the plan steps as a normal turn-by-turn workflow. Update ` +
          `plan step statuses as you go.`,
      };
    }
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

  private buildProgressResult(plan: Plan): ToolResult {
    const { completed, inProgress, pending } = countByStatus(plan.steps);

    const summary = `Plan updated: ${completed} completed, ${inProgress} in progress, ${pending} pending`;

    return {
      summary,
      output: 'OK',
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
