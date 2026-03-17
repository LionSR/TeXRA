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

/** Task state changed in a tool-use subagent (covers both todos and plans). */
export interface TodoProgressUpdate {
  readonly kind: 'todos';
  readonly todos: TodoItem[];
  readonly summary?: string | null;
}

/** Workflow round completed. */
export interface RoundProgressUpdate {
  readonly kind: 'round';
  readonly currentRound: number;
  readonly totalRounds: number;
}

/** Periodic overview of tool-use subagent activity. */
export interface OverviewProgressUpdate {
  readonly kind: 'overview';
  readonly toolCallCount: number;
  readonly filesChanged: string[];
  readonly cost?: number;
}

/**
 * @deprecated Use TodoProgressUpdate with summary instead.
 * Kept for backward compatibility during migration.
 */
export interface PlanProgressUpdate {
  readonly kind: 'plan';
  readonly plan: Plan | null;
}

/** Subagent has finished initialization and is about to call the model. */
export interface StartedProgressUpdate {
  readonly kind: 'started';
}

export type SubagentProgressUpdate =
  | TodoProgressUpdate
  | PlanProgressUpdate
  | RoundProgressUpdate
  | OverviewProgressUpdate
  | StartedProgressUpdate;
