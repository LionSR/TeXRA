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

export const ExtendedDocumentFileTypeSchema = z.enum([
  ...DocumentFileTypeSchema.options,
  'edited',
  'output',
]);
