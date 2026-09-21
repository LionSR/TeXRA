/**
 * The values the discriminated row arms of `SessionEventDraftSchema` carry.
 * The sibling of `runLedgerEvent.ts`: shapes only, the arms themselves live
 * in `sessionEvent.ts`, which is the single vocabulary the publisher and
 * both folds switch over.
 *
 * Two rows carry a discriminator rather than a type of their own, and each
 * one's discriminator is the whole of the tie: it names the family, selects
 * that family's value schema, and — for a stored value — names the aggregate
 * kind the value may live on. Corruption is refused where the bytes are read,
 * at the database's parse of `SessionEventSchema`.
 */
import { z } from 'zod';

import { InquiryThreadRecordSchema } from './inquiry';
import { JsonValueSchema } from './jsonValue';
import { PlanSchema } from './plan';
import { RoundKeyedOutputSidecarValueSchemas } from './runState';
import { TodoItemSchema } from './todo';
import { UpdateCheckRecordSchema } from './updateCheck';

/**
 * One durable run fact: the latest value of one key family on its run. One
 * row type, one aggregate kind (the run), five families. `key` is also what
 * the cold listing groups by beside the row type, so one family's newest row
 * never hides another's and a plan can never be committed under the todos
 * key.
 */
export const RunFactSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('todos'), todos: z.array(TodoItemSchema) }),
  z.object({ key: z.literal('plan'), plan: PlanSchema.nullable() }),
  z.object({
    key: z.literal('outputFiles'),
    filesByRound: RoundKeyedOutputSidecarValueSchemas.outputFiles,
  }),
  z.object({
    key: z.literal('missingOutputs'),
    filesByRound: RoundKeyedOutputSidecarValueSchemas.missingOutputs,
  }),
  z.object({
    key: z.literal('compileFailures'),
    filesByRound: RoundKeyedOutputSidecarValueSchemas.compileFailures,
  }),
]);

/** A stored value as the journal and the state store keep it: `undefined` is
 *  not JSON, so absence is an arm rather than a missing field. */
export const PersistedJsonValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('undefined') }),
  z.strictObject({ kind: z.literal('json'), value: JsonValueSchema }),
]);
export type PersistedJsonValue = z.infer<typeof PersistedJsonValueSchema>;

/**
 * One stored value, by the family that owns it: every host or application
 * state key, the desktop profile's remembered projects, one global inquiry
 * thread, and the update check. `key` is the aggregate kind the value lives
 * on, so an inquiry record cannot be committed under the update-check
 * aggregate. `{ kind: 'undefined' }` on the `app-state` arm is the delete,
 * the `vscode.Memento` contract every host's store mirrors.
 */
export const StoredValueSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('app-state'), value: PersistedJsonValueSchema }),
  z.object({
    key: z.literal('desktop-projects'),
    roots: z.array(z.string().min(1)),
  }),
  z.object({
    key: z.literal('global-inquiry'),
    record: InquiryThreadRecordSchema,
  }),
  z.object({ key: z.literal('update-check'), record: UpdateCheckRecordSchema }),
]);
export type StoredValue = z.infer<typeof StoredValueSchema>;
