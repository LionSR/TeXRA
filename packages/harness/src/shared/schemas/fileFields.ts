import { Effect, Schema } from 'effect';

/** The four canonical `*Files` list fields, defaulting to `[]` when absent. */
const fileListFields = {
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
};

/** Used by AgentConfig where `editedFile` may be null. */
export const NullableFileFieldsSchema = Schema.Struct({
  ...fileListFields,
  editedFile: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
