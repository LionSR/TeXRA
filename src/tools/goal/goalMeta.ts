import { z } from 'zod';

import { StreamTabIdSchema } from '@shared/schemas/identifiers';
import { PlanSchema } from '@shared/schemas/plan';

export const GOAL_FEATURE_FLAG_KEY = 'texra.goal.enabled' as const;

/**
 * Pre-rename keys, honored read-only for back-compat when a user explicitly set
 * one (see `isGoalEnabled()` in `goalFeatureFlag.ts`). The feature was called
 * "Odyssey" before June 2026: `texra.odyssey.enabled` was its canonical key and
 * `texra.experimental.odyssey.enabled` the original experimental flag. New
 * configs use `GOAL_FEATURE_FLAG_KEY`.
 */
export const LEGACY_GOAL_FEATURE_FLAG_KEYS = [
  'texra.odyssey.enabled',
  'texra.experimental.odyssey.enabled',
] as const;

/**
 * Optional USD spend cap for autonomous goals. `0` (the default) means
 * unbounded. Snapshotted into the goal record at `GoalStore.start` so editing
 * the setting mid-goal doesn't silently retarget a running budget.
 */
export const GOAL_COST_CAP_CONFIG_KEY = 'texra.goal.costCapUsd' as const;

/**
 * A goal is a live pursuit: it exists only while the autonomous loop is
 * running (`active`) or waiting for the user (`paused`). Finishing or
 * abandoning one drops the record entirely (`GoalStore.forget`) rather than
 * parking it in a terminal state — there is no audit log to preserve.
 */
export const GoalStatusSchema = z.enum(['active', 'paused']);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

/**
 * True when a record exists for the stream. With only `active`/`paused` as
 * persisted states, any record is an in-flight pursuit; complete/abandon
 * forget the record instead of transitioning it.
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
  /**
   * Structured plan that seeded the goal, when it was started from a
   * Plan-tool approval. Pure metadata for UI / inspection — the
   * continuation prompt still uses `objective` as the canonical instruction.
   */
  plan: PlanSchema.nullish(),
  /**
   * USD spend cap snapshot from `texra.goal.costCapUsd` at start.
   * Null/absent = unbounded. When `spentUsd` reaches this, the goal
   * auto-pauses (resumable) instead of continuing.
   */
  costCapUsd: z.number().positive().nullish(),
  /**
   * The stream's run cost (USD) when the goal first reported spend — spend
   * from before the goal started is excluded from the cap. Set lazily by
   * `GoalStore.noteRunCost` on its first observation.
   */
  baselineRunCostUsd: z.number().nonnegative().nullish(),
  /**
   * Total goal spend in USD: run cost since `baselineRunCostUsd`, which
   * already includes completed subagents (their cost rolls into the parent
   * run's usage accumulator at the delegation boundary).
   */
  spentUsd: z.number().nonnegative().prefault(0),
});
export type Goal = z.infer<typeof GoalSchema>;

/**
 * Wall-clock elapsed time since the goal was started.
 * Computed live so we don't need to accumulate ticks (which would either
 * be wrong while paused or wrong while idle between turns).
 */
export function goalElapsedMs(goal: { createdAt: string }): number {
  return Math.max(0, Date.now() - new Date(goal.createdAt).getTime());
}

export function goalDurationMs(goal: {
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}): number {
  const start = new Date(goal.createdAt).getTime();
  const end = isGoalInFlight(goal)
    ? Date.now()
    : new Date(goal.updatedAt).getTime();
  return Math.max(0, end - start);
}

/**
 * Hour-aware duration formatter for Goal timings. Lives here (not in
 * `@utils/core/stringCore`) so it's importable from webview frontends via
 * `@shared/schemas`, keeping the tool view and the settings tab in sync.
 */
export function formatGoalTime(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) return `${hours}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}
