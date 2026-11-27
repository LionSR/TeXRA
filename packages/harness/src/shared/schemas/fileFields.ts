import { Schema } from 'effect';
import { decodingDefault } from './schemaDefaults.js';

/** The three canonical `*Files` list fields of a run's launch, each
 *  defaulting to `[]` when absent. */
export const FileFieldsSchema = Schema.Struct({
  inputFiles: decodingDefault(Schema.Array(Schema.String), []),
  contextFiles: decodingDefault(Schema.Array(Schema.String), []),
  mediaFiles: decodingDefault(Schema.Array(Schema.String), []),
});
