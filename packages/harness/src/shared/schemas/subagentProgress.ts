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

export type SubagentProgressUpdate =
  PlanProgressUpdate | OverviewProgressUpdate | StartedProgressUpdate;
