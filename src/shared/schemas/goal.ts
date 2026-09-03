import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';

export const GOAL_FEATURE_FLAG_KEY = 'texra.goal.enabled' as const;

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

/**
 * Canonical goal-state shape: status/objective only exist while a goal is
 * active. This is the one definition of that union — `streamState.ts` and the
 * progress-view projection (`projectionShape.ts`) parse it directly, so the
 * shape has exactly one place to drift. The progress-view wire flattens it
 * per message arm (see `outbound.ts`'s GOAL_ACTIVE_UPDATED).
 */
export const GoalStateSchema = z.discriminatedUnion('active', [
  z.strictObject({ active: z.literal(false) }),
  z.strictObject({
    active: z.literal(true),
    status: GoalStatusSchema,
    objective: z.string(),
  }),
]);
export type GoalState = z.infer<typeof GoalStateSchema>;

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
