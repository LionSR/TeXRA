import { z } from 'zod';

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

/** Raw work-plan field types; callers apply their own fallback policy. */
export const WorkPlanSnapshotShape = {
  todos: z.array(TodoItemSchema),
  plan: PlanSchema.nullable(),
  planSummary: z.string().nullable(),
} satisfies z.ZodRawShape;

/** Current serializable shape for workspace plan and todo progress state. */
export const WorkPlanSnapshotSchema = z.strictObject({
  todos: WorkPlanSnapshotShape.todos.prefault([]),
  plan: WorkPlanSnapshotShape.plan.prefault(null),
  planSummary: WorkPlanSnapshotShape.planSummary.prefault(null),
});

export type WorkPlanSnapshot = z.output<typeof WorkPlanSnapshotSchema>;
