import { z } from 'zod';

import { DiffStatsSchema } from '@agent/types/DiffTypes';
import { ExecutionIdSchema } from './identifiers.js';

export const WorkspaceFileLocationSchema = z.strictObject({
  kind: z.literal('workspace'),
  absolutePath: z.string(),
  relativePath: z.string(),
});

export const RunStorageFileLocationSchema = z.strictObject({
  kind: z.literal('runStorage'),
  absolutePath: z.string(),
  relativePath: z.string(),
  executionId: ExecutionIdSchema,
});

export const ExternalFileLocationSchema = z.strictObject({
  kind: z.literal('external'),
  absolutePath: z.string(),
});

/** Discriminated union of all file location types */
export const FileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
  ExternalFileLocationSchema,
]);

/** Agent outputs are workspace or runStorage, never external */
export const AgentFileLocationSchema = z.discriminatedUnion('kind', [
  WorkspaceFileLocationSchema,
  RunStorageFileLocationSchema,
]);

export type WorkspaceFileLocation = z.infer<typeof WorkspaceFileLocationSchema>;
export type RunStorageFileLocation = z.infer<
  typeof RunStorageFileLocationSchema
>;
export type ExternalFileLocation = z.infer<typeof ExternalFileLocationSchema>;
export type FileLocation = z.infer<typeof FileLocationSchema>;
export type AgentFileLocation = z.infer<typeof AgentFileLocationSchema>;

export const OutputFileSchema = z.strictObject({
  source: z.string(),
  location: FileLocationSchema,
});

export const FileLineageSchema = z.strictObject({
  original: FileLocationSchema.nullable(),
  diffBase: FileLocationSchema.nullable(),
  diffFile: FileLocationSchema.nullable(),
});

export const OutputFileInfoSchema = OutputFileSchema.extend({
  round: z.number().prefault(() => 0),
  lineage: FileLineageSchema.nullable(),
  diff: DiffStatsSchema.nullable(),
});

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

export type OutputFile = z.infer<typeof OutputFileSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;

export const OutputXmlSummarySchema = z.strictObject({
  tagContents: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .prefault(() => ({})),
  documents: z.array(z.string()).prefault(() => []),
  singleOutputFile: z.string().nullable().prefault(null),
  sourceLocation: FileLocationSchema.nullable().prefault(null),
});
export type OutputXmlSummary = z.infer<typeof OutputXmlSummarySchema>;

export const RoundOutputSchema = z.strictObject({
  round: z.number(),
  rawOutput: FileLocationSchema.nullable(),
  outputs: OutputFileInfoSchema.array(),
  xmlSummary: OutputXmlSummarySchema,
});
export type RoundOutput = z.infer<typeof RoundOutputSchema>;
