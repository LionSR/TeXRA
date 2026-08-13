import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';

/**
 * A plan is a plain objective document: what to achieve, the intended
 * approach, and a verifiable stopping condition. It deliberately has no
 * structured steps — step tracking belongs to the todo tool — so the
 * document stays a clear objective statement that can seed an autonomous
 * goal verbatim.
 *
 * Pre-June-2026 plans were structured ({summary, steps[]}); those simply
 * fail to parse and read back as "no plan", which is fine — a plan only
 * matters for the session it was approved in.
 */
export const PlanSchema = z.strictObject({
  objective: z
    .string()
    .min(1)
    .describe(
      'The plan document: what to achieve, the approach, and a verifiable stopping condition',
    ),
});
export type Plan = z.infer<typeof PlanSchema>;

const UpdatePlanPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  plan: PlanSchema.nullable(),
});
export type UpdatePlanPayload = z.infer<typeof UpdatePlanPayloadSchema>;
