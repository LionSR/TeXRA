import { z } from 'zod';

import { isObject } from '@utils/core';

import { PlanSchema, type Plan } from './plan';
import { TodoItemSchema } from './todo';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parsePlan(value: unknown): Plan | null {
  const result = PlanSchema.safeParse(value);
  return result.success ? result.data : null;
}

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
  const plan = parsePlan(record.plan);
  const planSummary = plan
    ? planSummaryLine(plan.objective)
    : nonEmptyString(record.planSummary);

  return {
    todos: record.todos,
    plan,
    planSummary,
  };
}

/** Current serializable shape for workspace plan and todo progress state. */
export const WorkPlanSnapshotSchema = z.preprocess(
  normalizeWorkPlanSnapshot,
  z.strictObject({
    todos: z.array(TodoItemSchema).prefault([]),
    plan: PlanSchema.nullable().prefault(null),
    planSummary: z.string().nullable().prefault(null),
  }),
);

export type WorkPlanSnapshot = z.output<typeof WorkPlanSnapshotSchema>;
