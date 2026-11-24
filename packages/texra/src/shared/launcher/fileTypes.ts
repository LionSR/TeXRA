import { Schema } from 'effect';

export const DocumentFileTypeSchema = Schema.Literals([
  'input',
  'context',
  'media',
]);
export type DocumentFileType = typeof DocumentFileTypeSchema.Type;
