import { z } from 'zod';

import { formatCompactDuration } from '@utils/text/stringUtils';

import { StreamTabIdSchema } from './identifiers';

export const GOAL_FEATURE_FLAG_KEY = 'texra.goal.enabled' as const;

/**
 * Pre-rename keys, honored read-only for back-compat when a user explicitly set
 * one. The feature was called "Odyssey" before June 2026: `texra.odyssey.enabled`
 * was its canonical key and `texra.experimental.odyssey.enabled` the original
 * experimental flag. New configs use `GOAL_FEATURE_FLAG_KEY`.
 */
export const LEGACY_GOAL_FEATURE_FLAG_KEYS = [
  'texra.odyssey.enabled',
  'texra.experimental.odyssey.enabled',
] as const;

/**
 * A goal is a live pursuit: it exists only while the autonomous loop is running
 * (`active`) or waiting for the user (`paused`). Finishing or abandoning one
 * drops the record entirely rather than parking it in a terminal state.
 */
export const GoalStatusSchema = z.enum(['active', 'paused']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/**
 * True when a record exists for the stream. With only `active`/`paused` as
 * persisted states, any record is an in-flight pursuit; complete/abandon forget
 * the record instead of transitioning it.
 */
export function isGoalInFlight(
  goal: { status: GoalStatus } | null | undefined,
): boolean {
  return goal != null;
}

export const GoalSchema = z.object({
  goalId: z.string().min(1),
  streamId: StreamTabIdSchema,
  objective: z.string().min(1),
  status: GoalStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Goal = z.infer<typeof GoalSchema>;

/**
 * Wall-clock elapsed time since the goal was started.
 * Computed live so we don't need to accumulate ticks.
 */
export function goalElapsedMs(goal: { createdAt: string }): number {
  return Math.max(0, Date.now() - new Date(goal.createdAt).getTime());
}

/** Hour-aware duration formatter for Goal timings. */
export const formatGoalTime = formatCompactDuration;
