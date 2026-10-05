/**
 * The values stored rows carry. The sibling of `runHistoryEvent.ts`: shapes
 * only. The event arms live in `sessionEvent.ts`, the single vocabulary the
 * publisher and both folds switch over. The families of the `current_value`
 * table are declared by their owners (`ValueFamily`).
 *
 * A run fact carries a discriminator rather than a type of its own, and the
 * discriminator is the whole of the tie: it names the family and selects
 * that family's value schema. Corruption is refused where the bytes are
 * read, at the database's parse.
 */
import { z } from 'zod';

import { PlanSchema } from './plan';

/**
 * One durable run fact: the latest value of one key family on its run. One
 * row type, one aggregate kind (the run), one family today: the plan. `key`
 * is also what the cold listing groups by beside the row type.
 */
export const RunFactSchema = z.object({
  key: z.literal('plan'),
  plan: PlanSchema.nullable(),
});
