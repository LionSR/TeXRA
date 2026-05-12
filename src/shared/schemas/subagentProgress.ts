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
export interface TodoProgressUpdate {
  readonly kind: 'todos';
  readonly todos: TodoItem[];
}

/** Workflow round completed. */
export interface RoundProgressUpdate {
  readonly kind: 'round';
  readonly currentRound: number;
  readonly totalRounds: number;
  /** Workspace-relative (or external absolute) paths of files produced by
   *  this round. Empty when the round produced no output files. The
   *  orchestrator can read these on demand without waiting for the final
   *  delivery. */
  readonly outputPaths: readonly string[];
}

/** Periodic overview of tool-use subagent activity. */
export interface OverviewProgressUpdate {
  readonly kind: 'overview';
  readonly toolCallCount: number;
  readonly filesChanged: string[];
  readonly cost?: number;
}

/** Plan state changed in a tool-use subagent. */
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
