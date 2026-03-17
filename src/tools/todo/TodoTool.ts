/**
 * Unified task tracking tool for managing todo lists and implementation plans.
 *
 * This tool consolidates the previous separate `todo_write` and `plan` tools
 * into a single tool that supports both lightweight task tracking and rich
 * implementation plans with descriptions, file references, and approval flows.
 *
 * When a `summary` is provided and all items are `pending`, the tool pauses
 * execution and waits for user approval before returning (plan mode).
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { TaskState } from '@agent/core/AgentWorkspaceState';
import {
  planApprovalCoordinator,
  type PlanApprovalResult,
} from '@agent/runtime/PlanApprovalCoordinator';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import {
  TODO_STATUS,
  STATUS_DISPLAY,
  TodoItemSchema,
  PlanSchema,
  countByStatus,
  planToTodos,
  type TodoItem,
} from '@shared/schemas';
import { type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

const logger = new AgentLogger('TodoWriteTool');

/**
 * Schema for the todo_write tool input.
 * Supports both simple todos and rich plan-style items.
 */
const TodoWriteInputSchema = z.strictObject({
  /** The complete updated todo list */
  todos: z
    .array(TodoItemSchema)
    .describe('The updated todo list with all current tasks'),
  /** Optional high-level summary (triggers plan approval when all items are pending) */
  summary: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Brief overview of the task list. When provided with all-pending items, triggers plan approval.',
    ),
});

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

/** Counter for generating unique approval IDs */
let approvalCounter = 0;

/**
 * Unified tool for managing task lists and implementation plans.
 *
 * Use this tool to:
 * - Plan complex multi-step tasks by creating a todo list
 * - Track progress by updating task statuses
 * - Show users visibility into what the agent is working on
 * - Create implementation plans with descriptions and file references
 *
 * Task states:
 * - pending: Task not yet started
 * - in_progress: Currently working on (limit to ONE at a time)
 * - completed: Task finished successfully
 *
 * Each task needs two forms:
 * - content: Imperative form describing what to do (e.g., "Run tests")
 * - activeForm: Present continuous form for display (e.g., "Running tests")
 *
 * Optional rich fields for plan-style items:
 * - description: Detailed explanation of what the step involves
 * - files: List of files that will be created or modified
 *
 * Plan mode:
 * When you provide a `summary` and all items are "pending", this creates a
 * plan that is presented to the user for approval. Execution pauses until
 * they approve or reject. Progress updates (items already in_progress or
 * completed) are applied immediately.
 *
 * Best practices:
 * - Create todos BEFORE starting complex work
 * - Mark task as in_progress BEFORE beginning it
 * - Mark task as completed IMMEDIATELY after finishing
 * - Break large tasks into smaller, specific steps
 * - Remove tasks that are no longer relevant
 * - Use summary + description + files for implementation plans
 * - Keep only ONE task as in_progress at a time
 */
export class TodoWriteTool extends defineTool({
  name: 'todo_write',
  description: `Create and manage a structured task list for tracking progress on complex tasks.

Use this tool to:
- Plan multi-step tasks by breaking them into actionable items
- Track progress by updating task statuses (pending → in_progress → completed)
- Give users visibility into what you're working on
- Create implementation plans with descriptions and file references

Task states:
- pending: Task not yet started
- in_progress: Currently working on (limit to ONE at a time)
- completed: Task finished successfully

Each task needs two forms:
- content: Imperative form describing what to do (e.g., "Run tests")
- activeForm: Present continuous form for display (e.g., "Running tests")

Optional fields for richer plan-style items:
- description: Detailed explanation of what the step involves
- files: List of files that will be created or modified

Plan mode:
When you set a "summary" and all items are "pending", a plan is presented
to the user for approval. Execution pauses until they approve or reject.
If rejected, you receive their feedback and should revise. Progress updates
(marking items in_progress or completed) are applied immediately.

Best practices:
- Create todos BEFORE starting complex work
- Mark task as in_progress BEFORE beginning it
- Mark task as completed IMMEDIATELY after finishing
- Break large tasks into smaller, specific steps
- Remove tasks that are no longer relevant
- Use summary + description + files for implementation plans`,
  schema: TodoWriteInputSchema,
}) {
  protected async execute(input: TodoWriteInput): Promise<ToolResult> {
    const context = getCurrentToolFileInteractionContext();
    const taskState = context?.taskState ?? context?.todoState;

    if (!taskState) {
      logger.warn(
        'todo_write called without taskState in context - todos will not persist or display in UI',
      );
      return {
        summary: 'Updated todo list (no active session)',
        output: this.formatTodoList(input.todos, input.summary),
        diagnostics: {
          warning: 'No active todo context - todos may not persist',
        },
      };
    }

    const summary = input.summary ?? null;
    const isNewPlan =
      summary !== null &&
      input.todos.length > 0 &&
      input.todos.every((t) => t.status === TODO_STATUS.PENDING);

    // Update state immediately (shows in UI)
    taskState.updateTodos(input.todos, summary);

    if (isNewPlan && context?.streamId) {
      return this.requestApproval(
        input.todos,
        summary!,
        context.streamId,
        taskState,
      );
    }

    const { completed, inProgress, pending } = countByStatus(input.todos);
    const summaryText = summary ? `Plan: ${summary} — ` : '';
    return {
      summary: `${summaryText}${completed} completed, ${inProgress} in progress, ${pending} pending`,
      output: 'OK',
    };
  }

  /**
   * Request user approval for a new plan. Pauses execution until approved/rejected.
   */
  private async requestApproval(
    todos: TodoItem[],
    summary: string,
    streamId: string,
    taskState: TaskState,
  ): Promise<ToolResult> {
    const approvalId = `plan-${Date.now().toString(36)}-${++approvalCounter}`;

    logger.info(`Requesting approval for plan: ${summary}`);

    // Build Plan object for the approval flow
    const plan = {
      summary,
      steps: todos.map((t) => ({
        title: t.content,
        description: t.description ?? t.content,
        status: t.status,
        files: t.files ?? [],
      })),
    };
    // Validate with PlanSchema
    PlanSchema.parse(plan);

    const result: PlanApprovalResult =
      await planApprovalCoordinator.waitForApproval(streamId, {
        approvalId,
        plan,
      });

    if (result.action === 'approve') {
      logger.info('Plan approved by user');
      return {
        summary: 'Plan approved — proceed with implementation',
        output:
          'Plan approved by the user. You may now begin implementing the plan steps. Update step statuses as you work through them.',
      };
    }

    // Rejected or timed out — clear the plan from UI
    taskState.updateTodos([], null);

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
   * Format the todo list for display in the tool output (fallback when no UI context).
   */
  private formatTodoList(
    todos: TodoItem[],
    summary?: string | null,
  ): string {
    if (todos.length === 0) {
      return 'Todo list is empty.';
    }

    const lines: string[] = [];
    if (summary) {
      lines.push(`Plan: ${summary}`, '');
    } else {
      lines.push('Current todo list:', '');
    }

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const { icon, label } = STATUS_DISPLAY[todo.status];
      lines.push(`${i + 1}. ${icon} [${label}] ${todo.content}`);
      if (todo.description) {
        lines.push(`   ${todo.description}`);
      }
      if (todo.files && todo.files.length > 0) {
        lines.push(`   Files: ${todo.files.join(', ')}`);
      }
      if (
        todo.status === TODO_STATUS.IN_PROGRESS &&
        !todo.description
      ) {
        lines.push(`   → ${todo.activeForm}...`);
      }
    }

    return lines.join('\n');
  }
}
