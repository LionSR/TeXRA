/**
 * Todo tool for managing task lists during tool-use agent sessions.
 *
 * This tool allows agents to create and manage structured task lists,
 * helping track progress on complex multi-step tasks and showing
 * the user visibility into the agent's progress.
 */

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - tools
import { ToolCall } from '@agent/runtime/ToolCall';
import { TodoItemSchema, countByStatus } from '@shared/schemas';
import { ToolError } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';

/**
 * Schema for the todo_write tool input.
 * Uses TodoItemSchema from shared schemas as the single source of truth.
 */
const TodoWriteInputSchema = z.strictObject({
  /** The complete updated todo list */
  todos: z
    .array(TodoItemSchema)
    .describe('The updated todo list with all current tasks'),
});

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

const writeTodos = Effect.fn('TodoWriteTool.execute')(function* (
  input: TodoWriteInput,
) {
  const context = yield* ToolCall;

  if (!context.workPlanState) {
    return yield* Effect.fail(
      new ToolError(
        'todo_write requires an active agent tool-use turn: there is no work plan to update.',
      ),
    );
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
});

/** Tool for managing task lists during agent sessions. */
export const TodoWriteTool = defineTool({
  name: 'todo_write',
  description: `Create and manage a structured task list for tracking progress on complex multi-step tasks.
Task states: pending, in_progress, completed.
Each task needs two forms: content (imperative, e.g. "Run tests") and activeForm (present continuous shown while active, e.g. "Running tests").
Keep the list current as you work; one task in_progress at a time.`,
  schema: TodoWriteInputSchema,
  execute: writeTodos,
});
