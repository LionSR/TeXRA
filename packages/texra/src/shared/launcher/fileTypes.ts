import { Schema } from 'effect';

export const DocumentFileTypeSchema = Schema.Literals([
  'input',
  'context',
  'media',
]);
export type DocumentFileType = typeof DocumentFileTypeSchema.Type;

const MultipleDocumentFileTypeSchema = Schema.Literals([
  ...DocumentFileTypeSchema.literals,
  'output',
]);
export type MultipleDocumentFileType =
  (typeof MultipleDocumentFileTypeSchema)['Type'];

/** Narrows a broader file-type value to the `MultipleDocumentFileType` set. */
export const isMultipleDocumentFileType = Schema.is(
  MultipleDocumentFileTypeSchema,
);

/**
 * Values accepted by the "get/set current editor file" round trip
 * (`GET_CURRENT_FILE` / `SET_CURRENT_FILE`): a document file type, or the
 * diff-view pseudo-types 'base'/'edited', which aren't real file lists.
 */
export const CurrentFileTypeSchema = Schema.Union([
  DocumentFileTypeSchema,
  Schema.Literals(['base', 'edited']),
]);
