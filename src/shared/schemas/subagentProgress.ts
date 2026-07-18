/**
 * Subagent progress update types.
 *
 * These are pure data types with no implementation dependencies,
 * used by both @agent/ and @tools/ to communicate subagent progress.
 * Living in @shared/schemas/ breaks the circular dependency between
 * agent runtime and tools.
 */

import type { Plan } from './plan';
import type { TodoItem } from './todo';

/** Todo state changed in a tool-use subagent. */
interface TodoProgressUpdate {
  readonly kind: 'todos';
  readonly todos: TodoItem[];
}

/** Periodic overview of tool-use subagent activity. */
interface OverviewProgressUpdate {
  readonly kind: 'overview';
  readonly toolCallCount: number;
  readonly filesChanged: string[];
  readonly cost?: number;
}

/** Plan state changed in a tool-use subagent. */
interface PlanProgressUpdate {
  readonly kind: 'plan';
  readonly plan: Plan | null;
}

/** Subagent has finished initialization and is about to call the model. */
interface StartedProgressUpdate {
  readonly kind: 'started';
}

export type SubagentProgressUpdate =
  | TodoProgressUpdate
  | PlanProgressUpdate
  | OverviewProgressUpdate
  | StartedProgressUpdate;
