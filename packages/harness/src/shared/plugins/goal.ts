/**
 * The goal plugin's rows (its `arms`, `@tools/plugins`): the
 * goal of a run is its latest `plugin.fact` of kind `goal/state`, which
 * carries the whole pursuit. Core stores and folds the row without reading
 * it (`RunView.facts`); this module is its schema and its one reader, which
 * hosts, webviews and the plugin's own tools share. Browser-safe: it imports
 * only schemas.
 */
import { z } from 'zod';

import {
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';

/**
 * A goal is a live pursuit: it exists only while the autonomous loop is running
 * (`active`) or waiting for the user (`paused`). Finishing or abandoning one
 * publishes an inactive state rather than parking it in a terminal state.
 */
const GoalStatusSchema = z.enum(['active', 'paused']);

const ActiveGoalSchema = z.strictObject({
  goalId: z.string().min(1),
  status: GoalStatusSchema,
  objective: z.string().min(1),
  /** When the pursuit started; preserved across pause and retarget. */
  startedAt: z.iso.datetime(),
});

/** The goal's row value: a goal only exists while one is in flight. */
const GoalStateSchema = z.discriminatedUnion('active', [
  z.strictObject({ active: z.literal(false) }),
  ActiveGoalSchema.extend({ active: z.literal(true) }),
]);
export type GoalState = z.infer<typeof GoalStateSchema>;

/** One row of a cross-run goal list: an in-flight goal and the run it drives. */
const GoalSchema = ActiveGoalSchema.extend({ runId: RunIdSchema });
export type Goal = z.infer<typeof GoalSchema>;

/** The goal plugin's one row kind. */
export const GOAL_STATE_ARM = {
  plugin: 'goal',
  kind: 'state',
  version: 1,
  schema: GoalStateSchema,
  upcasters: [],
} as const;

/** The row that makes `state` the run's goal, for the one publisher. */
export function goalStateRow(
  runId: RunId,
  state: GoalState,
): SessionEventDraft {
  return {
    type: 'plugin.fact',
    aggregateId: qualifyAggregateId('run', runId),
    plugin: GOAL_STATE_ARM.plugin,
    kind: GOAL_STATE_ARM.kind,
    version: GOAL_STATE_ARM.version,
    parent: null,
    value: GoalStateSchema.parse(state),
  };
}

/** The run's goal as its latest goal row states it; none before the first. */
export function goalStateOf(run: Pick<RunView, 'facts'>): GoalState {
  const value = run.facts[`${GOAL_STATE_ARM.plugin}/${GOAL_STATE_ARM.kind}`];
  return value === undefined ? { active: false } : GoalStateSchema.parse(value);
}

/**
 * Wall-clock elapsed time since the goal was started, as of `nowMs` (the
 * caller's `Clock` reading, the same clock that stamped `startedAt`).
 * Computed live so we don't need to accumulate ticks.
 */
export function goalElapsedMs(
  goal: { startedAt: string },
  nowMs: number,
): number {
  return Math.max(0, nowMs - new Date(goal.startedAt).getTime());
}
