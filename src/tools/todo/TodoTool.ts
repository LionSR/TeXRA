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
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import { AgentLogger } from '@logger/AgentLogger';
import { type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local imports - logging

const logger = new AgentLogger('TodoWriteTool');

// Import todo schemas from single source of truth
import {
  TODO_STATUS,
  TodoItemSchema,
  type TodoItem,
  type TodoStatus,
} from '@eventBus/schemas';

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

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

/**
 * Tool for managing task lists during agent sessions.
 *
 * Use this tool to:
 * - Plan complex multi-step tasks by creating a todo list
 * - Track progress by updating task statuses
 * - Show users visibility into what the agent is working on
 *
 * Best practices:
 * - Use for tasks requiring 3+ distinct steps
 * - Mark tasks as in_progress BEFORE starting work
 * - Mark tasks as completed IMMEDIATELY after finishing
 * - Keep only ONE task as in_progress at a time
 * - Remove tasks that become irrelevant
 */
export class TodoWriteTool extends defineTool({
  name: 'todo_write',
  description: `Create and manage a structured task list for tracking progress on complex tasks.

Use this tool to:
- Plan multi-step tasks by breaking them into actionable items
- Track progress by updating task statuses (pending → in_progress → completed)
- Give users visibility into what you're working on

Task states:
- pending: Task not yet started
- in_progress: Currently working on (limit to ONE at a time)
- completed: Task finished successfully

Each task needs two forms:
- content: Imperative form describing what to do (e.g., "Run tests")
- activeForm: Present continuous form for display (e.g., "Running tests")

Best practices:
- Create todos BEFORE starting complex work
- Mark task as in_progress BEFORE beginning it
- Mark task as completed IMMEDIATELY after finishing
- Break large tasks into smaller, specific steps
- Remove tasks that are no longer relevant`,
  schema: TodoWriteInputSchema,
}) {
  protected async execute(input: TodoWriteInput): Promise<ToolResult> {
    const context = getCurrentToolFileInteractionContext();

    if (!context?.todoState) {
      // No context available - log warning and still format output
      logger.warn(
        'todo_write called without todoState in context - todos will not persist or display in UI',
      );
      return {
        summary: 'Updated todo list (no active session)',
        output: this.formatTodoList(input.todos),
        diagnostics: {
          warning: 'No active todo context - todos may not persist',
        },
      };
    }

    // Update the todos in workspace state
    // This triggers the onUpdate callback which emits events to the UI
    context.todoState.updateTodos(input.todos);

    const inProgressCount = input.todos.filter(
      (t) => t.status === TODO_STATUS.IN_PROGRESS,
    ).length;
    const completedCount = input.todos.filter(
      (t) => t.status === TODO_STATUS.COMPLETED,
    ).length;
    const pendingCount = input.todos.filter(
      (t) => t.status === TODO_STATUS.PENDING,
    ).length;

    const summary = `Todo list updated: ${completedCount} completed, ${inProgressCount} in progress, ${pendingCount} pending`;

    // Return minimal output - the UI already shows the input, no need to repeat the list
    return {
      summary,
      output: 'OK',
    };
  }

  /**
   * Format the todo list for display in the tool output.
   */
  private formatTodoList(todos: TodoItem[]): string {
    if (todos.length === 0) {
      return 'Todo list is empty.';
    }

    const lines: string[] = ['Current todo list:', ''];

    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const statusIcon = this.getStatusIcon(todo.status);
      const statusLabel = this.getStatusLabel(todo.status);
      lines.push(`${i + 1}. ${statusIcon} [${statusLabel}] ${todo.content}`);
      if (todo.status === TODO_STATUS.IN_PROGRESS) {
        lines.push(`   → ${todo.activeForm}...`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get a status icon for display.
   */
  private getStatusIcon(status: TodoStatus): string {
    switch (status) {
      case TODO_STATUS.PENDING:
        return '○';
      case TODO_STATUS.IN_PROGRESS:
        return '◐';
      case TODO_STATUS.COMPLETED:
        return '●';
    }
  }

  /**
   * Get a human-readable status label.
   */
  private getStatusLabel(status: TodoStatus): string {
    switch (status) {
      case TODO_STATUS.PENDING:
        return 'PENDING';
      case TODO_STATUS.IN_PROGRESS:
        return 'IN PROGRESS';
      case TODO_STATUS.COMPLETED:
        return 'COMPLETED';
    }
  }
}
