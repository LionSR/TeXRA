import { Effect, Schema } from 'effect';

/** The four canonical `*Files` list fields of a run's launch, each
 *  defaulting to `[]` when absent. */
export const FileFieldsSchema = Schema.Struct({
  inputFiles: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  contextFiles: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  mediaFiles: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  outputFiles: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
