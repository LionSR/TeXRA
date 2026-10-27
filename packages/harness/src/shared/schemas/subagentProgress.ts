/**
 * Subagent progress update types.
 *
 * These are pure data types with no implementation dependencies,
 * shared by the agent runtime and the tools to communicate subagent
 * progress.
 */

import type { Plan } from './plan';

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

/**
 * What a run reports through its `onProgress` callback while it works: that it
 * started, a periodic overview of its tool calls, changed files and cost, or a
 * change to its plan. A parent run's delegation tool and the session's
 * progress row read it.
 */
export type SubagentProgressUpdate =
  PlanProgressUpdate | OverviewProgressUpdate | StartedProgressUpdate;
