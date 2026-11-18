import { Schema } from 'effect';
import { decodingDefault } from './schemaDefaults.js';

/** The four canonical `*Files` list fields of a run's launch, each
 *  defaulting to `[]` when absent. */
export const FileFieldsSchema = Schema.Struct({
  inputFiles: decodingDefault(Schema.Array(Schema.String), []),
  contextFiles: decodingDefault(Schema.Array(Schema.String), []),
  mediaFiles: decodingDefault(Schema.Array(Schema.String), []),
  outputFiles: decodingDefault(Schema.Array(Schema.String), []),
});
