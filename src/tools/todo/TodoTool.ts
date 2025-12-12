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
import { toolResult, type ToolResult } from '@tools/result';
import { defineTool } from '@tools/core/define';

// Local file imports
import {
  getCurrentTodoContext,
  updateTodos,
  type TodoItem,
  type TodoStatus,
} from './TodoContext';

/**
 * Schema for a single todo item input.
 */
const TodoItemSchema = z.strictObject({
  /** The task description in imperative form (e.g., "Run tests", "Fix bug") */
  content: z.string().min(1).describe('Task description in imperative form'),
  /** Current status: pending, in_progress, or completed */
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('Current status of the task'),
  /** Present continuous form shown during execution (e.g., "Running tests") */
  activeForm: z
    .string()
    .min(1)
    .describe('Present continuous form for display during execution'),
});

/**
 * Schema for the todo_write tool input.
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
    const context = getCurrentTodoContext();

    if (!context) {
      // No context available - still store todos but warn
      return toolResult({
        summary: 'Updated todo list (no active session)',
        output: this.formatTodoList(input.todos),
        diagnostics: { warning: 'No active todo context - todos may not persist' },
      });
    }

    // Update the todos in context
    updateTodos(input.todos);

    // Format output for the model
    const output = this.formatTodoList(input.todos);
    const inProgressCount = input.todos.filter(
      (t) => t.status === 'in_progress',
    ).length;
    const completedCount = input.todos.filter(
      (t) => t.status === 'completed',
    ).length;
    const pendingCount = input.todos.filter(
      (t) => t.status === 'pending',
    ).length;

    const summary = `Todo list updated: ${completedCount} completed, ${inProgressCount} in progress, ${pendingCount} pending`;

    return toolResult({
      summary,
      output,
    });
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
      if (todo.status === 'in_progress') {
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
      case 'pending':
        return '○';
      case 'in_progress':
        return '◐';
      case 'completed':
        return '●';
    }
  }

  /**
   * Get a human-readable status label.
   */
  private getStatusLabel(status: TodoStatus): string {
    switch (status) {
      case 'pending':
        return 'PENDING';
      case 'in_progress':
        return 'IN PROGRESS';
      case 'completed':
        return 'COMPLETED';
    }
  }
}
