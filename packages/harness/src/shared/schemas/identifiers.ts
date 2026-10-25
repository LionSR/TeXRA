import { Schema } from 'effect';

/**
 * The one id a run has: minted once at launch, assigned
 * at `run.start`, and the key of every fact about that run. Hex: 12 chars
 * when generated, 24 when derived from a checkpoint identity. Branded so a
 * string that was never minted as a run id cannot be passed for one.
 */
export const RunIdSchema = Schema.String.check(Schema.isMinLength(6))
  .check(Schema.isPattern(/^[0-9a-f][-0-9a-f]*$/i))
  .pipe(Schema.brand('RunId'));
export type RunId = typeof RunIdSchema.Type;
/** Whether a string is a run id, as {@link RunIdSchema} reads it. */
export const isRunId = Schema.is(RunIdSchema);

/** A run id, or the empty-string sentinel meaning "no active run". */
export const RunSelectionSchema = Schema.Union([
  RunIdSchema,
  Schema.Literal(''),
]);
