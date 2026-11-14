import { Schema } from 'effect';

/** A whole number that is zero or more: a count, a size, an offset. */
export const NonNegativeIntSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);
