/**
 * Todo status constants for task tracking in tool-use agents.
 *
 * These constants define the possible states of a todo item.
 * This is the JavaScript version for webview ES modules.
 *
 * @sync Keep in sync with src/shared/schemas/todo.ts TODO_STATUS
 */

export const TODO_STATUS = {
  /** Task has not been started yet. */
  PENDING: 'pending',
  /** Task is currently being worked on. */
  IN_PROGRESS: 'in_progress',
  /** Task has been completed successfully. */
  COMPLETED: 'completed',
};
