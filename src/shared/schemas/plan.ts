import { z } from 'zod';

import type { StreamTabId } from './identifiers';

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

/**
 * Payload for a plan update. Declared as a plain type, not a schema: nothing
 * ever parses it — producers build the shape and consumers read it — so a Zod
 * schema would own no boundary.
 */
export interface UpdatePlanPayload {
  streamId: StreamTabId;
  plan: Plan | null;
}
