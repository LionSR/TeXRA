import { z } from 'zod';

import { isPlainObject } from '@shared/utils/string';

import { PlanSchema, type Plan } from './plan';
import { TodoItemSchema } from './todo';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parsePlan(value: unknown): Plan | null {
  const result = PlanSchema.safeParse(value);
  return result.success ? result.data : null;
}

function extractPlanSummary(value: unknown): string | null {
  return isPlainObject(value) ? nonEmptyString(value.summary) : null;
}

function normalizeWorkPlanSnapshot(input: unknown): unknown {
  const record = isPlainObject(input) ? input : {};
  const plan = parsePlan(record.plan);
  const planSummary =
    plan?.summary ??
    nonEmptyString(record.planSummary) ??
    extractPlanSummary(record.plan);

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
