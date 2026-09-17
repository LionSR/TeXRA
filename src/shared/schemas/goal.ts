import { z } from 'zod';

import { RunIdSchema } from './identifiers';

export const GOAL_FEATURE_FLAG_KEY = 'texra.goal.enabled' as const;

/**
 * A goal is a live pursuit: it exists only while the autonomous loop is running
 * (`active`) or waiting for the user (`paused`). Finishing or abandoning one
 * publishes an inactive state rather than parking it in a terminal state.
 */
const GoalStatusSchema = z.enum(['active', 'paused']);

/**
 * The pursuit itself, as the run's latest `goalStateChanged` row states it:
 * the row carries the whole goal, so the fold's `RunView.goal` is the goal
 * and no store holds a second copy.
 */
const ActiveGoalSchema = z.strictObject({
  goalId: z.string().min(1),
  status: GoalStatusSchema,
  objective: z.string().min(1),
  /** When the pursuit started; preserved across pause and retarget. */
  startedAt: z.iso.datetime(),
});

/**
 * Canonical goal-state shape: the goal only exists while one is in flight.
 * This is the one definition of that union — the session fold parks it on
 * `RunView.goal` and every renderer reads it from there.
 */
export const GoalStateSchema = z.discriminatedUnion('active', [
  z.strictObject({ active: z.literal(false) }),
  ActiveGoalSchema.extend({ active: z.literal(true) }),
]);
export type GoalState = z.infer<typeof GoalStateSchema>;

/** One row of a cross-run goal list: an in-flight goal and the run it drives. */
const GoalSchema = ActiveGoalSchema.extend({ runId: RunIdSchema });
export type Goal = z.infer<typeof GoalSchema>;

/**
 * A goal-list row as the settings view receives it: the goal plus the run's
 * display label (`RunView.label`, the identity's display name), so the list
 * can name the run instead of showing its hex id. The label travels on the
 * row because only the session fold owns it — a renderer must never re-derive
 * it. The hex `runId` stays the reveal action's argument.
 */
export const GoalListItemSchema = GoalSchema.extend({ runLabel: z.string() });
export type GoalListItem = z.infer<typeof GoalListItemSchema>;

/**
 * Wall-clock elapsed time since the goal was started.
 * Computed live so we don't need to accumulate ticks.
 */
export function goalElapsedMs(goal: { startedAt: string }): number {
  return Math.max(0, Date.now() - new Date(goal.startedAt).getTime());
}
