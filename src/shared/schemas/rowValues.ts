/**
 * The values stored rows carry. The sibling of `runHistoryEvent.ts`: shapes
 * only. The event arms live in `sessionEvent.ts`, the single vocabulary the
 * publisher and both folds switch over; the current values are the families
 * of the `current_value` table.
 *
 * A run fact carries a discriminator rather than a type of its own, and the
 * discriminator is the whole of the tie: it names the family and selects
 * that family's value schema. Corruption is refused where the bytes are
 * read, at the database's parse.
 */
import { z } from 'zod';

import { InquiryThreadRecordSchema } from './inquiry';
import { JsonValueSchema } from './jsonValue';
import { PlanSchema } from './plan';
import { UpdateCheckRecordSchema } from './updateCheck';

/**
 * One durable run fact: the latest value of one key family on its run. One
 * row type, one aggregate kind (the run), one family today: the plan. `key`
 * is also what the cold listing groups by beside the row type.
 */
export const RunFactSchema = z.object({
  key: z.literal('plan'),
  plan: PlanSchema.nullable(),
});

/**
 * The families of the current-value table: application state, not history.
 * One row per family and key, replaced in place by each write and kept
 * outside the event tables, so an event-format bump never clears it. Each
 * family names the schema its value decodes with at the database boundary; a
 * row that no longer decodes fails the read.
 *
 * `app-state` is the process's settings store and `repo-state` the settings
 * shared by every checkout of one repository (keyed by repository root and
 * key); a write of `undefined` deletes their row. The other families only
 * ever replace a value.
 */
export const CURRENT_VALUE_SCHEMAS = {
  'app-state': JsonValueSchema,
  'repo-state': JsonValueSchema,
  /** The desktop's remembered and recently closed projects, one value so
   *  one write changes both lists. */
  'desktop-projects': z.object({
    remembered: z.array(z.string().min(1)),
    recent: z.array(z.string().min(1)),
  }),
  inquiry: InquiryThreadRecordSchema,
  'update-check': UpdateCheckRecordSchema,
  /** The global root's record of a workspace store, keyed by its storage
   *  directory id: the root it serves, so `texra doctor --prune-storage`
   *  can tell a store whose root is gone. */
  'workspace-store': z.object({ root: z.string().min(1) }),
};
export type CurrentValueFamily = keyof typeof CURRENT_VALUE_SCHEMAS;
export type CurrentValue<F extends CurrentValueFamily> = z.infer<
  (typeof CURRENT_VALUE_SCHEMAS)[F]
>;
/** The families whose row a write may delete. */
export type DeletableFamily = 'app-state' | 'repo-state';
