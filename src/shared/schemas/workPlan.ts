import { z } from 'zod';

import { isNonEmptyString, isObject } from '@utils/core';

import { PlanSchema } from './plan';
import { TodoItemSchema } from './todo';

/** One-line label for a plan document: its first non-empty line. */
export function planSummaryLine(objective: string): string {
  const first = objective
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? '(empty plan)';
}

function normalizeWorkPlanSnapshot(input: unknown): unknown {
  const record = isObject(input) ? input : {};
  // Legacy structured plans fail to parse and read back as "no plan";
  // their stored planSummary string still carries the one-line label.
  const plan = PlanSchema.nullable().catch(null).parse(record.plan);
  let planSummary: string | null = null;
  if (plan) {
    planSummary = planSummaryLine(plan.objective);
  } else if (isNonEmptyString(record.planSummary)) {
    planSummary = record.planSummary;
  }

  return {
    todos: record.todos,
    plan,
    planSummary,
  };
}

/** Raw work-plan field types; callers apply their own fallback policy. */
export const WorkPlanSnapshotShape = {
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  planSummary: z.string().nullable(),
} satisfies z.ZodRawShape;

/** Current serializable shape for workspace plan and todo progress state. */
export const WorkPlanSnapshotSchema = z.preprocess(
  normalizeWorkPlanSnapshot,
  z.strictObject({
    todos: WorkPlanSnapshotShape.todos.prefault([]),
    plan: WorkPlanSnapshotShape.plan.prefault(null),
    planSummary: WorkPlanSnapshotShape.planSummary.prefault(null),
  }),
);

export type WorkPlanSnapshot = z.output<typeof WorkPlanSnapshotSchema>;
