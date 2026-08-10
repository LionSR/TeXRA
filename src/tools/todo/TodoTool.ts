/**
 * Todo tool for managing task lists during tool-use agent sessions.
 *
 * This tool allows agents to create and manage structured task lists,
 * helping track progress on complex multi-step tasks and showing
 * the user visibility into the agent's progress.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { createChannelTrace } from '@agent/trace';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import {
  TODO_STATUS,
  STATUS_DISPLAY,
  TodoItemSchema,
  countByStatus,
  type TodoItem,
} from '@shared/schemas';
import { type ToolResult } from '@shared/schemas/toolResult';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';

const logger = createChannelTrace('TodoWriteTool');

/**
 * Schema for the todo_write tool input.
 * Uses TodoItemSchema from eventBus/schemas as single source of truth.
 */
const TodoWriteInputSchema = z.strictObject({
  /** The complete updated todo list */
  todos: z
    .array(TodoItemSchema)
    .describe('The updated todo list with all current tasks'),
});

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

/** Tool for managing task lists during agent sessions. */
export class TodoWriteTool extends defineTool({
  name: 'todo_write',
  description: `Create and manage a structured task list for tracking progress on complex multi-step tasks.
Task states: pending, in_progress, completed.
Each task needs two forms: content (imperative, e.g. "Run tests") and activeForm (present continuous shown while active, e.g. "Running tests").
Keep the list current as you work; one task in_progress at a time.`,
  schema: TodoWriteInputSchema,
}) {
  protected async execute(input: TodoWriteInput): Promise<ToolResult> {
    const context = getCurrentToolCallContext();

    if (!context?.workPlanState) {
      // No context available - log warning and still format output
      logger.warn(
        'todo_write called without workPlanState in context - todos will not persist or display in UI',
      );
      return {
        status: 'executed',
        summary: 'Updated todo list (no active session)',
        output: formatTodoList(input.todos),
        diagnostics: {
          warning: 'No active todo context - todos may not persist',
        },
      };
    }

    // Update the todos in workspace state
    // This triggers the onUpdate callback which emits events to the UI
    context.workPlanState.updateTodos(input.todos);

    const { completed, inProgress, pending } = countByStatus(input.todos);

    // Return minimal output - the UI already shows the input, no need to repeat the list
    return executed(
      'OK',
      `Todo list updated: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
    );
  }
}

/** Format the todo list for display in the tool output. */
function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }

  const lines: string[] = ['Current todo list:', ''];

  for (const [i, todo] of todos.entries()) {
    const { icon, label } = STATUS_DISPLAY[todo.status];
    lines.push(`${i + 1}. ${icon} [${label}] ${todo.content}`);
    if (todo.status === TODO_STATUS.IN_PROGRESS) {
      lines.push(`   → ${todo.activeForm}...`);
    }
  }

  return lines.join('\n');
}
