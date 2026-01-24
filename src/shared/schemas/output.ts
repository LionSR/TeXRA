// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { DiffStatsSchema } from '@agent/types/DiffTypes';

// Local imports - shared schemas
import { ExecutionIdSchema } from './identifiers';

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

export type WorkspaceFileLocation = z.infer<typeof WorkspaceFileLocationSchema>;
export type RunStorageFileLocation = z.infer<
  typeof RunStorageFileLocationSchema
>;
export type ExternalFileLocation = z.infer<typeof ExternalFileLocationSchema>;
export type FileLocation = z.infer<typeof FileLocationSchema>;

/** Minimal output file reference - source name + location */
export const OutputFileSchema = z.strictObject({
  source: z.string(),
  location: FileLocationSchema,
});

/** File lineage - tracks where files came from */
export const FileLineageSchema = z.strictObject({
  original: FileLocationSchema.nullable(),
  diffBase: FileLocationSchema.nullable(),
  diffFile: FileLocationSchema.nullable(),
});

/** Complete output file metadata (extends OutputFileSchema) */
export const OutputFileInfoSchema = OutputFileSchema.extend({
  round: z.number().prefault(() => 0), // Default for legacy persisted data
  lineage: FileLineageSchema.nullable(),
  diff: DiffStatsSchema.nullable(),
});

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();

export type OutputFile = z.infer<typeof OutputFileSchema>;
export type FileLineage = z.infer<typeof FileLineageSchema>;
export type OutputFileInfo = z.infer<typeof OutputFileInfoSchema>;
