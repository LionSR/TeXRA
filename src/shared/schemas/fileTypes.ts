import { z } from 'zod';

export const DocumentFileTypeSchema = z.enum(['input', 'context', 'media']);
export type DocumentFileType = z.infer<typeof DocumentFileTypeSchema>;

export const MultipleDocumentFileTypeSchema = z.enum([
  ...DocumentFileTypeSchema.options,
  'output',
]);
export type MultipleDocumentFileType = z.infer<
  typeof MultipleDocumentFileTypeSchema
>;
export const MULTIPLE_DOCUMENT_FILE_TYPES =
  MultipleDocumentFileTypeSchema.options;

/** Narrows a broader file-type value (e.g. `ExtendedDocumentFileType`) to `MultipleDocumentFileType`. */
export function isMultipleDocumentFileType(
  value: string,
): value is MultipleDocumentFileType {
  return (MULTIPLE_DOCUMENT_FILE_TYPES as readonly string[]).includes(value);
}

export const ExtendedDocumentFileTypeSchema = z.enum([
  ...DocumentFileTypeSchema.options,
  'edited',
  'output',
]);
type ExtendedDocumentFileType = z.infer<typeof ExtendedDocumentFileTypeSchema>;

/**
 * Values accepted by the "get/set current editor file" round trip
 * (`GET_CURRENT_FILE` / `SET_CURRENT_FILE`): a document file type, or the
 * diff-view pseudo-types 'base'/'edited', which aren't real file lists.
 */
export const CurrentFileTypeSchema = z.union([
  DocumentFileTypeSchema,
  z.enum(['base', 'edited']),
]);
