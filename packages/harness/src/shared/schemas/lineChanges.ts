import { Schema, Struct } from 'effect';
import { NonNegativeIntSchema } from './nonNegativeInt';

/**
 * Schema for line change statistics.
 */
export const LineChangesSchema = Schema.Struct({
  added: NonNegativeIntSchema,
  removed: NonNegativeIntSchema,
});

/**
 * Schema for diff statistics where one side may be absent.
 */
export const DiffStatsSchema = LineChangesSchema.mapFields(
  Struct.map(Schema.optional),
);
export type DiffStats = typeof DiffStatsSchema.Type;
