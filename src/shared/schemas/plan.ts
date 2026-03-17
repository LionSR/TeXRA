/**
 * Plan schemas — derived from the unified TodoItem schema.
 *
 * A "plan" is a todo list with a summary and richer item metadata.
 * These schemas exist for backward compatibility and for the plan
 * approval flow. Internally, plans are stored as todo items with
 * optional description/files fields.
 */

import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';
import { TodoItemSchema, TodoStatusSchema } from './todo';

/**
 * PlanStep is a TodoItem that requires description and files.
 * Used by the plan approval flow and legacy API surfaces.
 */
export const PlanStepSchema = z.strictObject({
  title: z.string().min(1).describe('Short title for this step'),
  description: z
    .string()
    .min(1)
    .describe('Detailed description of what this step involves'),
  status: TodoStatusSchema,
  files: z
    .array(z.string())
    .prefault([])
    .describe('Files involved in this step'),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.strictObject({
  summary: z
    .string()
    .min(1)
    .describe('Brief overview of the implementation plan'),
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .describe('Ordered list of implementation steps'),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Convert a Plan into the unified todo format (summary + TodoItem[]). */
export function planToTodos(plan: Plan): {
  summary: string;
  todos: z.infer<typeof TodoItemSchema>[];
} {
  return {
    summary: plan.summary,
    todos: plan.steps.map((step) => ({
      content: step.title,
      status: step.status,
      activeForm: step.title,
      description: step.description,
      files: step.files.length > 0 ? step.files : undefined,
    })),
  };
}

export const UpdatePlanPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  plan: PlanSchema.nullable(),
});
export type UpdatePlanPayload = z.infer<typeof UpdatePlanPayloadSchema>;
