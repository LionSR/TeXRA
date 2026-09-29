/**
 * The values stored rows carry. The sibling of `runLedgerEvent.ts`: shapes
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
import { TodoItemSchema } from './todo';
import { UpdateCheckRecordSchema } from './updateCheck';

/**
 * One durable run fact: the latest value of one key family on its run. One
 * row type, one aggregate kind (the run), two families. `key` is also what
 * the cold listing groups by beside the row type, so one family's newest row
 * never hides another's and a plan can never be committed under the todos
 * key.
 */
export const RunFactSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('todos'), todos: z.array(TodoItemSchema) }),
  z.object({ key: z.literal('plan'), plan: PlanSchema.nullable() }),
]);

/** A value as the workflow journal keeps it: `undefined` is not JSON, so
 *  absence is an arm rather than a missing field. */
export const PersistedJsonValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('undefined') }),
  z.strictObject({ kind: z.literal('json'), value: JsonValueSchema }),
]);
export type PersistedJsonValue = z.infer<typeof PersistedJsonValueSchema>;

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
};
export type CurrentValueFamily = keyof typeof CURRENT_VALUE_SCHEMAS;
export type CurrentValue<F extends CurrentValueFamily> = z.infer<
  (typeof CURRENT_VALUE_SCHEMAS)[F]
>;
/** The families whose row a write may delete. */
export type DeletableFamily = 'app-state' | 'repo-state';
