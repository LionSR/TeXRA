/**
 * Plan tool — thin wrapper that converts Plan input into unified todo format.
 *
 * @deprecated Use todo_write with summary + description + files instead.
 * This tool is kept for backward compatibility with existing agent prompts.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PlanSchema,
  planToTodos,
  STATUS_DISPLAY,
  countByStatus,
} from '@shared/schemas';
import { type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';
import { TodoWriteTool } from '@tools/todo/TodoTool';

const logger = new AgentLogger('PlanTool');

const PlanToolInputSchema = z.strictObject({
  plan: PlanSchema.describe('The structured implementation plan'),
});

export type PlanToolInput = z.infer<typeof PlanToolInputSchema>;

/**
 * @deprecated Use todo_write with summary, description, and files fields instead.
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
  private todoTool = new TodoWriteTool();

  protected async execute(input: PlanToolInput): Promise<ToolResult> {
    // Convert plan to unified todo format and delegate
    const { summary, todos } = planToTodos(input.plan);
    return this.todoTool.call({ todos, summary });
  }
}
