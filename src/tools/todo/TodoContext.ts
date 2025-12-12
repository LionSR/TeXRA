/**
 * Context for managing todo state during tool-use agent sessions.
 * Uses a context stack pattern similar to ToolFileInteractionContext.
 */

// Type imports
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

/**
 * Status of a todo item.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Schema for a single todo item.
 */
export interface TodoItem {
  /** The task description in imperative form (e.g., "Run tests") */
  content: string;
  /** Current status of the task */
  status: TodoStatus;
  /** Present continuous form shown during execution (e.g., "Running tests") */
  activeForm: string;
}

/**
 * Context for storing todo state during a tool-use session.
 */
export interface TodoContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  /** Current todo list for this session */
  todos: TodoItem[];
  /** Callback to notify UI of todo updates */
  onUpdate?: (todos: TodoItem[]) => void;
}

const contextStack: TodoContext[] = [];

/**
 * Execute a function within a todo context.
 * The context provides access to the todo list and allows updates.
 */
export function withTodoContext<T>(
  context: TodoContext,
  run: () => Promise<T> | T,
): Promise<T> {
  contextStack.push(context);
  const maybeCleanup = () => {
    const index = contextStack.lastIndexOf(context);
    if (index >= 0) {
      contextStack.splice(index, 1);
    }
  };

  try {
    const result = run();
    return Promise.resolve(result).finally(maybeCleanup);
  } catch (error) {
    maybeCleanup();
    throw error;
  }
}

/**
 * Get the current todo context from the stack.
 * Returns undefined if no context is active.
 */
export function getCurrentTodoContext(): TodoContext | undefined {
  if (contextStack.length === 0) {
    return undefined;
  }
  return contextStack.at(-1);
}

/**
 * Update the todos in the current context.
 * Notifies the UI if an onUpdate callback is registered.
 */
export function updateTodos(todos: TodoItem[]): void {
  const context = getCurrentTodoContext();
  if (!context) {
    return;
  }
  context.todos = todos;
  context.onUpdate?.(todos);
}

/**
 * Get the current todos from the active context.
 * Returns an empty array if no context is active.
 */
export function getCurrentTodos(): TodoItem[] {
  const context = getCurrentTodoContext();
  return context?.todos ?? [];
}
