/**
 * Plan tool for creating structured implementation plans during tool-use agent sessions.
 *
 * Unlike todo_write (which tracks execution progress), this tool lets the agent
 * outline an implementation strategy with numbered steps, descriptions, and file
 * references — giving the user visibility into the agent's approach before and
 * during execution.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TODO_STATUS,
  PlanSchema,
  type Plan,
  type PlanStep,
  type TodoStatus,
} from '@shared/schemas';
import { type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const logger = new AgentLogger('PlanTool');

/** Configuration for displaying plan step status — icon and label for each status */
const STATUS_DISPLAY: Record<TodoStatus, { icon: string; label: string }> = {
  [TODO_STATUS.PENDING]: { icon: '○', label: 'PENDING' },
  [TODO_STATUS.IN_PROGRESS]: { icon: '◐', label: 'IN PROGRESS' },
  [TODO_STATUS.COMPLETED]: { icon: '●', label: 'COMPLETED' },
};

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
 */
export class PlanTool extends defineTool({
  name: 'plan',
  description: `Create a structured implementation plan to outline your approach before executing.

Use this tool to:
- Present a clear strategy to the user before making changes
- Break down complex tasks into numbered steps with descriptions
- Show which files will be involved in each step
- Track progress through the plan as you work

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
    const context = getCurrentToolFileInteractionContext();

    if (!context?.planState) {
      logger.warn(
        'plan called without planState in context — plan will not persist or display in UI',
      );
      return {
        summary: 'Created plan (no active session)',
        output: this.formatPlan(input.plan),
        diagnostics: {
          warning: 'No active plan context — plan may not persist',
        },
      };
    }

    // Update the plan in workspace state
    // This triggers the onUpdate callback which emits events to the UI
    context.planState.updatePlan(input.plan);

    let completedCount = 0;
    let inProgressCount = 0;
    let pendingCount = 0;
    for (const s of input.plan.steps) {
      if (s.status === TODO_STATUS.COMPLETED) completedCount++;
      else if (s.status === TODO_STATUS.IN_PROGRESS) inProgressCount++;
      else pendingCount++;
    }

    const summary = `Plan updated: ${completedCount} completed, ${inProgressCount} in progress, ${pendingCount} pending`;

    // Return minimal output — the UI already shows the plan
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
