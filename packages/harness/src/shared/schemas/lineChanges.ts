import { Schema, Struct } from 'effect';

/**
 * Nonnegative line-count schema shared by tool results, approvals, and output
 * diff statistics.
 */
export const LineCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

/**
 * Schema for line change statistics.
 */
export const LineChangesSchema = Schema.Struct({
  added: LineCountSchema,
  removed: LineCountSchema,
});

/**
 * Schema for diff statistics where one side may be absent.
 */
export const DiffStatsSchema = LineChangesSchema.mapFields(
  Struct.map(Schema.optional),
);
export type DiffStats = typeof DiffStatsSchema.Type;
