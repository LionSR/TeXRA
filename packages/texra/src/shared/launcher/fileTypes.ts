import { Schema } from 'effect';

export const DocumentFileTypeSchema = Schema.Literals([
  'input',
  'context',
  'media',
]);
export type DocumentFileType = typeof DocumentFileTypeSchema.Type;

/**
 * Values accepted by the current-editor-file host request
 * (`useCurrentFile`, `shared/session/hostRequest.ts`): a document file type, or the
 * diff-view pseudo-types 'base'/'edited', which aren't real file lists.
 */
export const CurrentFileTypeSchema = Schema.Union([
  DocumentFileTypeSchema,
  Schema.Literals(['base', 'edited']),
]);
