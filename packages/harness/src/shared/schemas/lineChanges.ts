import { Schema } from 'effect';
import { NonNegativeIntSchema } from './nonNegativeInt';

/**
 * Schema for line change statistics.
 */
export const LineChangesSchema = Schema.Struct({
  added: NonNegativeIntSchema,
  removed: NonNegativeIntSchema,
});
