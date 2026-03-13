import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';
import { TodoStatusSchema } from './todo';

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

export const UpdatePlanPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  plan: PlanSchema.nullable(),
});
export type UpdatePlanPayload = z.infer<typeof UpdatePlanPayloadSchema>;
